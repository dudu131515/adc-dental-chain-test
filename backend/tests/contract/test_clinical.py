from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from adc.booking.models import Appointment, DepositPayment, DepositRefund, SlotClaim
from adc.catalog.models import TreatmentPrice, TreatmentType
from adc.clinical.models import Material, TreatmentItem
from adc.scheduling.models import DentalChair, Shift
from tests.fixtures.scenarios import load_synthetic_base


class ClinicalContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def setUp(self):
        password = "clinical-synthetic-password"
        hashed = make_password(password)
        config = override_settings(ADC_STAFF_PASSWORD_HASHES={
            "demo.front-a": hashed, "demo.dentist": hashed, "demo.front-b": hashed,
        })
        config.enable()
        self.addCleanup(config.disable)
        self.front, self.dentist, self.other = [self.sign_in(role, password) for role in ("front-a", "dentist", "front-b")]
        treatment = TreatmentType.objects.create(
            treatment_code="ADC-CLINICAL", treatment_name="合成检查", standard_unit="次", default_slot_minutes=30,
        )
        self.chair = DentalChair.objects.create(clinic_id=1, chair_no="CF-A-1")
        start = timezone.now() + timedelta(minutes=5)
        end = start + timedelta(minutes=30)
        shift = Shift.objects.create(clinic_id=1, dentist_id=1, start_at=start, end_at=end, status="PUBLISHED")
        self.claim = SlotClaim.objects.create(
            clinic_id=1, dentist_id=1, patient_id=1, shift=shift, requested_treatment_type=treatment,
            start_at=start, end_at=end, status="CONFIRMED",
        )
        self.deposit = DepositPayment.objects.create(claim=self.claim, status="PAID", paid_at=timezone.now())
        self.appointment = Appointment.objects.create(
            claim=self.claim, deposit=self.deposit, status="CONFIRMED", appointment_no="ADC-CLINICAL-01",
        )
        self.route = "/api/v1/appointments/" + str(self.appointment.pk)

    def sign_in(self, role, password):
        client = Client()
        response = client.post(
            "/api/v1/auth/web/login", {"login_identity": "demo." + role, "password": password},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        return client

    def action(self, client, name, key, **extra):
        return client.post(
            self.route + "/" + name, {"expected_claim_id": str(self.claim.pk), **extra},
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
        )

    def check_in_and_start(self):
        refused = self.action(self.dentist, "start-visit", "clinical-early-start")
        self.assertEqual(refused.status_code, 409, refused.content)
        checked = self.action(self.front, "check-in", "clinical-signin", identity_confirmed=True)
        self.assertEqual(checked.status_code, 200, checked.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "CHECKED_IN")
        self.assertFalse(self.appointment.is_attended)
        available = self.front.get(self.route + "/chair-options")
        self.assertEqual(available.status_code, 200, available.content)
        self.assertEqual([c["chair_id"] for c in available.json()["data"]["items"]], [str(self.chair.pk)])
        assigned = self.action(self.front, "assign-chair", "clinical-chair", chair_id=str(self.chair.pk))
        self.assertEqual(assigned.status_code, 200, assigned.content)
        with self.captureOnCommitCallbacks(execute=True):
            started = self.action(self.dentist, "start-visit", "clinical-visit")
            self.assertIn(started.status_code, (200, 201), started.content)
        return started.json()["data"]["visit_id"]

    def test_sign_in_and_actual_start_are_separate_and_refund_only_once(self):
        rejected = self.action(self.other, "check-in", "clinical-cross-clinic", identity_confirmed=True)
        self.assertIn(rejected.status_code, (403, 404))
        visit_id = self.check_in_and_start()
        again = self.action(self.dentist, "start-visit", "clinical-visit")
        self.assertEqual(again.json()["data"]["visit_id"], visit_id)
        self.appointment.refresh_from_db()
        self.assertTrue(self.appointment.is_attended)
        self.assertEqual(self.appointment.status, "IN_TREATMENT")
        self.assertEqual(DepositRefund.objects.filter(deposit=self.deposit).count(), 1)
        self.assertEqual(str(DepositRefund.objects.get(deposit=self.deposit).refund_amount), "50.00")

    def test_zero_treatment_requires_termination_and_releases_chair_and_claim(self):
        visit_id = self.check_in_and_start()
        route = "/api/v1/visits/" + visit_id
        blocked = self.dentist.post(
            route + "/finish", {}, content_type="application/json", HTTP_IDEMPOTENCY_KEY="clinical-normal-close",
        )
        self.assertEqual(blocked.status_code, 409, blocked.content)
        terminated = self.dentist.post(
            route + "/terminate", {"reason": "合成无治疗中止"},
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="clinical-terminate",
        )
        self.assertEqual(terminated.status_code, 200, terminated.content)
        self.assertEqual(terminated.json()["data"]["status"], "TERMINATED")
        self.claim.refresh_from_db()
        self.appointment.refresh_from_db()
        self.assertEqual(self.claim.status, "RELEASED")
        self.assertEqual(self.appointment.status, "COMPLETED")
        self.assertTrue(self.appointment.is_attended)

    def test_declined_extra_work_does_not_become_a_charge_and_approved_work_freezes_its_price(self):
        visit_id = self.check_in_and_start()
        path = "/api/v1/visits/" + visit_id
        project = self.claim.requested_treatment_type
        TreatmentPrice.objects.create(
            treatment_type=project, unit_price="120.00", effective_from=timezone.localdate(),
        )
        proposal = {"treatment_type_id": str(project.pk), "evidence_ref": "合成追加说明"}
        declined = self.dentist.post(
            path + "/additional-decisions", {**proposal, "decision": "DECLINED"},
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="clinical-extra-no",
        )
        self.assertEqual(declined.status_code, 201, declined.content)
        performed = {"treatment_type_id": str(project.pk), "units": "1.500", "is_additional": True}
        not_performed = self.dentist.post(
            path + "/treatment-items", {**performed, "decision_id": declined.json()["data"]["decision_id"]},
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="clinical-extra-denied-item",
        )
        self.assertEqual(not_performed.status_code, 409, not_performed.content)
        self.assertFalse(TreatmentItem.objects.filter(visit_id=visit_id).exists())
        approved = self.dentist.post(
            path + "/additional-decisions", {**proposal, "decision": "ACCEPTED"},
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="clinical-extra-yes",
        )
        self.assertEqual(approved.status_code, 201, approved.content)
        entry = self.dentist.post(
            path + "/treatment-items", {**performed, "decision_id": approved.json()["data"]["decision_id"]},
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="clinical-extra-confirmed-item",
        )
        self.assertEqual(entry.status_code, 201, entry.content)
        self.assertEqual(entry.json()["data"]["amount"], "180.00")
        TreatmentType.objects.filter(pk=project.pk).update(treatment_name="合成后来调整名称")
        old = self.dentist.get(path).json()["data"]["treatment_items"][0]
        self.assertEqual(old["name"], "合成检查")
        self.assertEqual(old["unit_price"], "120.00")

    def test_failed_appointment_deposit_refund_retries_the_same_original_obligation(self):
        with override_settings(ADC_SIMULATION_OUTCOMES={"deposit_refund": "FAILED"}):
            self.check_in_and_start()
        failed = DepositRefund.objects.get(deposit=self.deposit)
        self.assertEqual(failed.status, "FAILED")
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "IN_TREATMENT")
        with self.captureOnCommitCallbacks(execute=True):
            retried = self.front.post("/api/v1/deposit-refunds/" + str(failed.pk) + "/retry")
            self.assertIn(retried.status_code, (200, 202), retried.content)
        failed.refresh_from_db()
        self.assertEqual(failed.status, "SUCCEEDED")
        self.assertEqual(DepositRefund.objects.filter(deposit=self.deposit).count(), 1)

    def test_material_cost_must_match_evidence_and_is_frozen_for_the_responsible_dentist(self):
        visit_id = self.check_in_and_start()
        route = "/api/v1/visits/" + visit_id
        TreatmentPrice.objects.create(
            treatment_type=self.claim.requested_treatment_type, unit_price="120.00", effective_from=timezone.localdate(),
        )
        material = Material.objects.create(material_code="ADC-MATERIAL-COST", material_name="合成耗材", standard_unit="件")
        fields = {"treatment_type_id": str(self.claim.requested_treatment_type_id), "units": "1.000",
                  "materials": [{"material_id": str(material.pk), "quantity": "1.250", "cost_evidence_ref": "ADC-VERIFIED-COST"}]}
        blocked = self.dentist.post(
            route + "/treatment-items", fields, content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-missing",
        )
        self.assertEqual(blocked.status_code, 409, blocked.content)
        self.assertFalse(TreatmentItem.objects.filter(visit_id=visit_id).exists())
        with TemporaryDirectory() as folder:
            file = Path(folder) / "adc-costs.json"
            file.write_text('{"ADC-MATERIAL-COST":[{"reference":"ADC-VERIFIED-COST","effective_from":"2020-01-01","unit_cost":"8.00"}]}', encoding="utf-8")
            with override_settings(ADC_MATERIAL_COSTS_PATH=str(file)):
                accepted = self.dentist.post(
                    route + "/treatment-items", fields, content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-verified",
                )
                self.assertEqual(accepted.status_code, 201, accepted.content)
        current = self.dentist.get(route).json()["data"]["materials"][0]
        self.assertEqual((current["quantity"], current["unit_cost"]), ("1.250", "8.00"))
        self.assertNotIn("materials", self.front.get(route).json()["data"])
