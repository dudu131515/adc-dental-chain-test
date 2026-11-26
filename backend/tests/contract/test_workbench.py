from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from adc.booking.models import Appointment, DepositPayment, SlotClaim
from adc.catalog.models import TreatmentType
from adc.identity.models import EmployeeRole, UserAccount
from adc.scheduling.models import Shift
from tests.fixtures.scenarios import load_synthetic_base


class WorkbenchAlertTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()
        start = timezone.now() - timedelta(minutes=25)
        end = start + timedelta(minutes=30)
        project = TreatmentType.objects.create(
            treatment_code="DOT", treatment_name="合成检查", standard_unit="次", default_slot_minutes=30,
        )
        shift = Shift.objects.create(clinic_id=1, dentist_id=1, start_at=start, end_at=end, status="PUBLISHED")
        claim = SlotClaim.objects.create(
            patient_id=1, clinic_id=1, dentist_id=1, shift=shift, requested_treatment_type=project,
            start_at=start, end_at=end, status="CONFIRMED",
        )
        deposit = DepositPayment.objects.create(claim=claim, status="PAID", paid_at=start)
        cls.booking = Appointment.objects.create(
            appointment_no="ADC-DOT-TEST", claim=claim, deposit=deposit, status="CHECKED_IN",
        )

    def staff(self, identity):
        client = Client()
        session = client.session
        session["account_id"] = UserAccount.objects.get(login_identity="demo." + identity).pk
        session["adc_channel"] = "staff"
        session.save()
        return client

    def flags(self, actor, clinic=None):
        return actor.get("/api/v1/workbench/alerts", {"clinic_id": clinic} if clinic else {})

    def test_front_desk_scope_and_booleans_only(self):
        first = self.flags(self.staff("front-a"), 1)
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(first.json()["data"], {
            "schedule": True, "clinical": False, "billing": False, "reconciliation": False, "corrections": False,
        })
        self.assertEqual(self.flags(self.staff("front-b"), 1).status_code, 403)
        self.assertFalse(self.flags(self.staff("front-b"), 2).json()["data"]["schedule"])
        next_day = timezone.localdate() + timedelta(days=3)
        other_day = self.staff("front-a").get("/api/v1/workbench/alerts", {"clinic_id": 1, "date": next_day})
        self.assertFalse(other_day.json()["data"]["schedule"])

    def test_dentist_alert_drops_after_its_store_grant_is_revoked(self):
        dentist = self.staff("dentist")
        initial = self.flags(dentist).json().get("data", {})
        self.assertTrue(initial.get("clinical"), initial)
        EmployeeRole.objects.filter(employee_id=1, role__role_code="DENTIST", scope_clinic_id=1).delete()
        self.assertFalse(self.flags(dentist).json()["data"]["clinical"])

    def test_unpromoted_funds_light_the_reconciliation_route_only(self):
        deposit = self.booking.deposit
        self.booking.delete()
        deposit.status = "PENDING"
        deposit.payment_token = "synthetic-pending-workbench"
        deposit.paid_at = None
        deposit.save(update_fields=("status", "payment_token", "paid_at"))
        first = self.flags(self.staff("front-a"), 1).json()["data"]
        self.assertFalse(first["billing"])
        self.assertTrue(first["reconciliation"])
        self.assertFalse(self.flags(self.staff("front-b"), 2).json()["data"]["reconciliation"])
