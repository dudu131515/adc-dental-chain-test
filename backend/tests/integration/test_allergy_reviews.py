from datetime import timedelta

from django.contrib.auth.hashers import make_password
from django.test import Client, SimpleTestCase, TestCase, override_settings
from django.urls import resolve
from django.utils import timezone

from adc.booking.models import Appointment, AppointmentChange, DepositPayment, SlotClaim
from adc.catalog.models import TreatmentType
from adc.clinical.models import PatientAllergy, Visit
from adc.identity.models import AuditLog, EmployeeRole
from adc.scheduling.models import Shift
from tests.fixtures.scenarios import load_synthetic_base


class AllergyRouteTests(SimpleTestCase):
    def test_appointment_scoped_command_exists(self):
        self.assertEqual(resolve("/api/v1/appointments/1/allergy-reviews").kwargs, {"pk": 1})


class AllergyReviewTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()
        cls.treatment = TreatmentType.objects.create(
            treatment_code="ALLERGY", treatment_name="合成复诊", standard_unit="次", default_slot_minutes=30,
        )
        cls.password = "synthetic-allergy-test"
        cls.digest = make_password(cls.password)

    def setUp(self):
        cfg = override_settings(ADC_STAFF_PASSWORD_HASHES={
            "demo." + role: self.digest for role in ("dentist", "front-a", "manager-a")
        })
        cfg.enable()
        self.addCleanup(cfg.disable)
        self.dentist = self.login("dentist")
        self.booking = self.make_booking(1)

    def login(self, role):
        client = Client()
        response = client.post("/api/v1/auth/web/login", {
            "login_identity": "demo." + role, "password": self.password,
        }, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        return client

    def make_booking(self, offset, patient=1):
        start = timezone.now() + timedelta(days=offset)
        end = start + timedelta(minutes=30)
        shift = Shift.objects.create(clinic_id=1, dentist_id=1, start_at=start, end_at=end, status="PUBLISHED")
        claim = SlotClaim.objects.create(
            clinic_id=1, dentist_id=1, patient_id=patient, requested_treatment_type=self.treatment,
            shift=shift, start_at=start, end_at=end, status="CONFIRMED",
        )
        deposit = DepositPayment.objects.create(claim=claim, status="PAID", paid_at=timezone.now())
        return Appointment.objects.create(
            claim=claim, deposit=deposit, status="CHECKED_IN", appointment_no=f"ALLERGY-{offset}",
        )

    def context(self, booking):
        response = self.dentist.get(f"/api/v1/appointments/{booking.pk}/clinical-context")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def review(self, version, status, allergies, key, *, client=None, booking=None, expected=201):
        target = booking or self.booking
        response = (client or self.dentist).post(f"/api/v1/appointments/{target.pk}/allergy-reviews", {
            "expected_version": version, "expected_claim_id": str(target.claim_id),
            "status": status, "allergies": allergies,
        }, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(response.status_code, expected, response.content)
        return response.json()

    def start(self):
        self.booking.status = "IN_TREATMENT"
        self.booking.is_attended = True
        self.booking.save(update_fields=("status", "is_attended"))
        return Visit.objects.create(
            appointment=self.booking, main_dentist_id=1, started_at=timezone.now(), status="IN_PROGRESS",
        )

    def test_empty_is_unverified_and_patient_confirmation_carries_to_future_encounters(self):
        self.assertEqual(self.context(self.booking)["allergy_review"]["status"], "UNVERIFIED")
        first = self.review("0", "NONE_KNOWN", [], "first")["data"]
        self.assertEqual(self.review("0", "NONE_KNOWN", [], "first", expected=200)["data"], first)
        self.review("0", "KNOWN", [{"allergen": "合成药物"}], "first", expected=409)
        new_patient = self.make_booking(2, patient=2)
        self.assertEqual(self.context(new_patient)["allergy_review"]["history"], [])
        next_booking = self.make_booking(3)
        previous = self.context(next_booking)["allergy_review"]
        self.assertEqual(previous["status"], "NONE_KNOWN")
        self.assertEqual(previous["version"], first["review_id"])
        self.assertEqual(previous["history"][0]["dentist_name"], "合成责任牙医")
        self.assertEqual(previous["history"][0]["appointment_id"], str(self.booking.pk))
        self.assertTrue(previous["history"][0]["reviewed_at"])

    def test_legacy_rows_edits_removal_stale_writes_and_redacted_audit(self):
        row = PatientAllergy.objects.create(patient_id=1, allergen_name="合成甲", notes="旧说明")
        view = self.context(self.booking)
        self.assertEqual(view["allergy_review"]["status"], "KNOWN")
        self.assertEqual(view["allergy_review"]["history"], [])
        self.start()
        entries = [{"allergen": " 合成甲 ", "notes": "新说明"}, {"allergen": "合成乙", "notes": ""}]
        changed = self.review("0", "KNOWN", entries, "revision")["data"]
        self.assertEqual(changed["changes"], {"added": 1, "updated": 1, "removed": 0})
        row.refresh_from_db()
        self.assertEqual(row.notes, "新说明")
        conflict = self.review("0", "NONE_KNOWN", [], "stale", expected=409)
        self.assertEqual(conflict["error"]["code"], "STALE_ALLERGY_REVIEW")
        self.assertEqual(PatientAllergy.objects.filter(patient_id=1).count(), 2)
        cleared = self.review(changed["review_id"], "NONE_KNOWN", [], "clear")["data"]
        self.assertEqual(cleared["changes"], {"added": 0, "updated": 0, "removed": 2})
        self.assertFalse(PatientAllergy.objects.filter(patient_id=1).exists())
        log = AuditLog.objects.get(pk=changed["review_id"])
        self.assertEqual(log.account_id, 1)
        evidence = str((log.before_value, log.after_value))
        for sensitive in ("合成甲", "合成乙", "旧说明", "新说明"):
            self.assertNotIn(sensitive, evidence)


    def test_review_provenance_survives_a_cross_store_claim_transfer(self):
        event = self.review("0", "KNOWN", [{"allergen": "合成过敏原"}], "before-transfer")["data"]
        old = self.booking.claim
        grant = EmployeeRole.objects.get(employee_id=1, role__role_code="DENTIST", scope_clinic_id=1)
        EmployeeRole.objects.get_or_create(employee_id=1, role_id=grant.role_id, scope_clinic_id=2)
        start = old.start_at + timedelta(hours=2)
        end = start + timedelta(minutes=30)
        shift = Shift.objects.create(clinic_id=2, dentist_id=1, start_at=start, end_at=end, status="PUBLISHED")
        new = SlotClaim.objects.create(
            clinic_id=2, dentist_id=1, patient_id=1, shift=shift, requested_treatment_type=self.treatment,
            start_at=start, end_at=end, status="CONFIRMED",
        )
        old.status = "RELEASED"
        old.save(update_fields=("status",))
        self.booking.claim, self.booking.status = new, "CONFIRMED"
        self.booking.save(update_fields=("claim", "status"))
        AppointmentChange.objects.create(appointment=self.booking, change_type="RESCHEDULE", old_claim=old, new_claim=new)
        follow_up = self.make_booking(3)
        audit = AuditLog.objects.get(pk=event["review_id"])
        for old_format in (False, True):
            if old_format:
                audit.after_value.pop("clinic_id", None)
                audit.after_value.pop("claim_id", None)
                audit.save(update_fields=("after_value",))
            context = self.context(self.booking)
            self.assertEqual(context["allergy_review"]["history"], [])
            self.assertEqual(context["allergy_review"]["version"], event["review_id"])
            self.assertEqual(context["allergies"][0]["allergen"], "合成过敏原")
            self.assertEqual(self.context(follow_up)["allergy_review"]["history"], [event])

    def test_invalid_payloads_leave_records_and_history_untouched(self):
        invalid = [
            ("KNOWN", []), ("KNOWN", [{"allergen": " "}]),
            ("KNOWN", [{"allergen": "Lidocaine"}, {"allergen": " lidocaine "}]),
            ("NONE_KNOWN", [{"allergen": "合成甲"}]), ("UNVERIFIED", []),
            ("KNOWN", [{"allergen": "合" * 121}]),
        ]
        for index, (status, entries) in enumerate(invalid):
            with self.subTest(index=index):
                self.review("0", status, entries, f"invalid-{index}", expected=400)
        self.assertEqual(self.context(self.booking)["allergy_review"]["history"], [])
        self.assertFalse(PatientAllergy.objects.exists())

    def test_only_responsible_scoped_dentist_may_read_or_write_and_closed_detail_is_frozen(self):
        self.booking.status = "CONFIRMED"
        self.booking.save(update_fields=("status",))
        self.review("0", "NONE_KNOWN", [], "too-early", expected=409)
        self.booking.status = "CHECKED_IN"
        self.booking.save(update_fields=("status",))
        first = self.review("0", "NONE_KNOWN", [], "checked")["data"]
        visit = self.start()
        entry = [{"allergen": "合成敏感原"}]
        front = self.login("front-a")
        EmployeeRole.objects.create(employee_id=4, scope_clinic_id=1, role_id=1)
        other = self.login("manager-a")
        for role, client, denied in [("front", front, 403), ("other", other, 404)]:
            self.review(first["review_id"], "KNOWN", entry, role, client=client, expected=denied)
            self.assertEqual(client.get(f"/api/v1/appointments/{self.booking.pk}/clinical-context").status_code, denied)
        detail = f"/api/v1/visits/{visit.pk}"
        current = self.dentist.get(detail)
        self.assertEqual(current.status_code, 200, current.content)
        self.assertEqual(current.json()["data"]["allergy_reviews"], [first])
        self.assertNotIn("allergy_reviews", front.get(detail).json()["data"])
        self.assertNotIn(other.get(detail).status_code, (200, 201))
        visit.status, visit.ended_at = "TERMINATED", timezone.now()
        visit.termination_reason = "合成中止"
        visit.save()
        self.booking.status = "COMPLETED"
        self.booking.save(update_fields=("status",))
        self.review(first["review_id"], "KNOWN", entry, "closed", expected=409)
        self.review(first["review_id"], "KNOWN", entry, "next", booking=self.make_booking(2))
        old = self.dentist.get(detail).json()["data"]["allergy_reviews"]
        self.assertEqual([event["review_id"] for event in old], [first["review_id"]])
        EmployeeRole.objects.filter(employee_id=1, role_id=1, scope_clinic_id=1).delete()
        self.assertNotIn(self.dentist.get(detail).status_code, (200, 201))
