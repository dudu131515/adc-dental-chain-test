from datetime import datetime, time, timedelta
from unittest.mock import patch

from django.contrib.auth.hashers import make_password
from django.db import connection
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from adc.booking.models import Appointment, DepositRefund
from adc.clinical.models import PatientAllergy, Visit
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.models import DentalChair
from scripts.grant_db_access import configure_access
from tests.fixtures.scenarios import load_synthetic_base


class ADCLifecycleTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()
        cls.chair = DentalChair.objects.create(clinic_id=1, chair_no="ADC-E2E-A")
        DentalChair.objects.create(clinic_id=2, chair_no="ADC-E2E-B")
        PatientAllergy.objects.create(patient_id=1, allergen_name="合成过敏提示", notes="临床授权验证")

    def call(self, actor, route, payload=None, *, expected=(200,), key=None):
        extra = self.bearer if actor == "patient" else {}
        client = self.clients[actor]
        if key:
            extra = {**extra, "HTTP_IDEMPOTENCY_KEY": key}
        response = client.get("/api/v1" + route, **extra) if payload is None else client.post(
            "/api/v1" + route, payload, content_type="application/json", **extra,
        )
        self.assertIn(response.status_code, expected, response.content)
        return response.json().get("data", {})

    def publish(self, clinic, start, end, transfer=False):
        work = self.call("scheduler", "/shifts", {
            "clinic_id": str(clinic), "dentist_id": "1", "start_at": start.isoformat(), "end_at": end.isoformat(),
        }, expected=(201,))
        path = "/shifts/" + work["shift_id"]
        self.call("scheduler", path + "/submit", {})
        self.call("dentist", path + "/respond", {"decision": "ACCEPTED"})
        self.call("scheduler", path + "/publish", {"route_feasible": True, "evidence_ref": "合成两店路线复核"} if transfer else {})
        return work["shift_id"]

    def test_patient_payment_through_confirmed_quarter_and_booked_financial_adjustment(self):
        with connection.cursor() as cursor:
            cursor.execute("CREATE ROLE adc_test_lifecycle_app NOLOGIN")
            configure_access(cursor, "business", "adc_test_lifecycle_app")
            cursor.execute("SET LOCAL ROLE adc_test_lifecycle_app")
        password = "adc-lifecycle-synthetic-secret"
        actors = ("front-a", "front-b", "dentist", "manager-a", "scheduler", "catalog", "calculate", "review", "confirm", "reports")
        digest = make_password(password)
        config = override_settings(
            ADC_STAFF_PASSWORD_HASHES={"demo." + actor: digest for actor in actors},
            ADC_MINI_SYNTHETIC_CODES={"lifecycle-auth-code": "adc-demo-patient-a"},
        )
        self.clients = {role: Client() for role in (*actors, "patient")}
        self.bearer = {}
        with config:
            for actor in actors:
                self.call(actor, "/auth/web/login", {"login_identity": "demo." + actor, "password": password})
            mini = self.call("patient", "/auth/mini/login", {"code": "lifecycle-auth-code"})
            self.bearer = {"HTTP_AUTHORIZATION": "Bearer " + mini["token"]}
        today = timezone.localdate()
        tomorrow = today + timedelta(days=1)
        at = datetime.combine(tomorrow, time(9), tzinfo=BUSINESS_ZONE)
        project = self.call("catalog", "/catalog/treatments", {
            "treatment_code": "ADC-E2E-CATALOG", "treatment_name": "合成实际收费项目", "standard_unit": "次",
            "default_slot_minutes": 30, "active": True,
        }, expected=(201,))["treatment_type_id"]
        self.call("catalog", f"/catalog/treatments/{project}/prices", {"unit_price": "120.00", "effective_from": str(today)}, expected=(201,))
        self.publish(1, at, at + timedelta(hours=1))
        other = self.publish(2, at + timedelta(hours=2), at + timedelta(hours=3), transfer=True)
        criteria = f"?clinic_id=1&date={tomorrow}&treatment_type_id={project}"
        candidate = self.call("patient", "/booking/options" + criteria)["items"][0]
        reservation = {key: candidate[key] for key in (
            "clinic_id", "dentist_id", "shift_id", "start_at", "end_at", "treatment_type_id",
        )}
        hold = self.call("patient", "/holds", reservation, expected=(201,), key="lifecycle-hold")
        deposit = "/deposit-payments/" + hold["payment"]["deposit_id"]
        with self.captureOnCommitCallbacks(execute=True):
            self.call("patient", deposit + "/simulate", {}, expected=(200, 202))
        paid = self.call("patient", deposit)
        appointment = "/appointments/" + paid["appointment_id"]
        self.assertEqual(self.call("front-a", appointment)["appointment_no"], paid["appointment_no"])
        prior = {"expected_claim_id": hold["claim_id"]}
        forbidden = self.call("front-b", appointment + "/check-in", {**prior, "identity_confirmed": True}, expected=(403, 404), key="outside-store")
        self.assertEqual(forbidden, {})
        self.call("front-a", appointment + "/reschedule", {
            **prior, "clinic_id": "2", "shift_id": other, "dentist_id": "1", "cause": "CLINIC",
            "start_at": (at + timedelta(hours=2)).isoformat(), "end_at": (at + timedelta(hours=2, minutes=30)).isoformat(),
            "reason": "合成跨店未获两店授权", "patient_consent_ref": "synthetic-consent",
        }, key="cannot-transfer", expected=(403, 404))
        self.assertEqual(self.call("patient", appointment)["claim_id"], hold["claim_id"])
        with patch("django.utils.timezone.now", return_value=at):
            self.call("front-a", appointment + "/check-in", {**prior, "identity_confirmed": True}, key="lifecycle-checkin")
            self.assertFalse(DepositRefund.objects.exists())
            self.assertNotIn("allergies", self.call("front-a", appointment))
            self.call("front-a", appointment + "/assign-chair", {**prior, "chair_id": str(self.chair.pk)}, key="lifecycle-chair")
            context = self.call("dentist", appointment + "/clinical-context")
            self.assertEqual(context["allergies"][0]["allergen"], "合成过敏提示")
            with self.captureOnCommitCallbacks(execute=True):
                started = self.call("dentist", appointment + "/start-visit", prior, expected=(201,), key="lifecycle-start")
            self.call("dentist", "/visits/" + started["visit_id"] + "/treatment-items", {
                "treatment_type_id": project, "units": "1.000",
            }, expected=(201,), key="lifecycle-actual")
        actual = "/visits/" + started["visit_id"]
        with patch("django.utils.timezone.now", return_value=at + timedelta(minutes=15)):
            self.call("dentist", actual + "/finish", {"clinical_notes": "合成诊疗正文"}, key="lifecycle-finish")
            self.assertFalse(self.call("dentist", actual)["can_issue_invoice"])
            self.assertTrue(self.call("front-a", actual)["can_issue_invoice"])
            invoice = self.call("front-a", actual + "/invoice", {}, expected=(201,), key="lifecycle-issue")
            self.assertNotIn("clinical_notes", self.call("front-a", actual))
            with self.captureOnCommitCallbacks(execute=True):
                self.call("front-a", "/invoices/" + invoice["invoice_id"] + "/payments", {"amount": "120.00"},
                          expected=(201, 202), key="lifecycle-payment")
        quarter = self.call("calculate", "/performance/periods", {"year": at.year, "quarter": (at.month - 1) // 3 + 1})
        period = "/performance/periods/" + quarter["period_id"]
        self.call("calculate", period + "/calculate", {}, key="lifecycle-first-calc")
        self.call("review", period + "/revisions/1/review", {"decision": "APPROVED", "reason": "合成季度复核"}, key="lifecycle-first-review")
        frozen = self.call("confirm", period + "/revisions/1/confirm", {}, key="lifecycle-first-confirm")
        self.assertEqual(frozen["company"]["incentive_fund"], "12.00")
        requested = self.call("dentist", actual + "/corrections", {
            "invoice_id": invoice["invoice_id"], "reason": "合成项目差额",
            "proposed_changes": {"summary": "调整同次应计", "signed_amount": "-20.00"},
        }, expected=(201,), key="lifecycle-adjust")
        correction = "/corrections/" + requested["correction_id"]
        self.call("manager-a", correction + "/decision", {"decision": "APPROVED", "reason": "合成主管核对"}, key="lifecycle-approval")
        revision_source = self.call("front-a", correction + "/apply", {"invoice_id": invoice["invoice_id"]}, key="lifecycle-apply")
        draft = self.call("calculate", period + "/calculate", {}, key="lifecycle-second-calc")
        self.assertEqual(draft["source"]["adjustment_id"], revision_source["adjustment_id"])
        self.assertEqual(self.call("reports", period)["latest_confirmed"]["revision_no"], 1)
        self.call("review", period + "/revisions/2/review", {"decision": "APPROVED", "reason": "合成修订复核"}, key="lifecycle-second-review")
        revised = self.call("confirm", period + "/revisions/2/confirm", {}, key="lifecycle-second-confirm")
        self.assertEqual(revised["company"]["incentive_fund"], "10.00")
        cutoff = at + timedelta(hours=3)
        with patch("adc.reporting.operations_api.now", return_value=cutoff):
            data = self.call("reports", f"/reports/operations?date_from={today}&date_to={tomorrow}&clinic_ids=1")
        self.assertEqual(data["appointments"]["attendance_rate"]["value"], "1")
        self.assertEqual(data["financial"]["accrued"], "100.00")
        self.assertEqual(data["performance"][0]["revision_no"], 2)
        details = self.call("reports", f"/reports/operations/details?report_token={data['report_token']}&metric=attended")
        self.assertEqual(details["items"][0]["appointment_no"], paid["appointment_no"])
        self.assertNotIn("patient_display", details["items"][0])
        self.assertEqual(Appointment.objects.count(), 1)
        self.assertEqual(Visit.objects.count(), 1)
        self.assertEqual(DepositRefund.objects.get().status, "SUCCEEDED")
