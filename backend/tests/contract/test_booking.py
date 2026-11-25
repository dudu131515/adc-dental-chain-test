from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth.hashers import make_password
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client, TestCase, override_settings

from adc.catalog.models import TreatmentType
from adc.booking.models import Appointment, AppointmentChange, SlotClaim
from adc.identity.models import Patient
from adc.scheduling.models import DentalChair, DentalChairUnavailability, Shift
from tests.fixtures.scenarios import load_synthetic_base


class BookingIdentityContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def setUp(self):
        password_hash = make_password("booking-synthetic-password")
        config = override_settings(
            ADC_MINI_SYNTHETIC_CODES={"adc-booking-patient-a": "adc-demo-patient-a"},
            ADC_STAFF_PASSWORD_HASHES={"demo.front-a": password_hash, "demo.scheduler": password_hash},
        )
        config.enable()
        self.addCleanup(config.disable)
        self.patient = Client()
        self.front = Client()
        verified = self.patient.post(
            "/api/v1/auth/mini/login", {"code": "adc-booking-patient-a"}, content_type="application/json",
        ).json()["data"]
        self.bearer = {"HTTP_AUTHORIZATION": "Bearer " + verified["token"]}
        response = self.front.post(
            "/api/v1/auth/web/login", {"login_identity": "demo.front-a", "password": "booking-synthetic-password"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

    def test_patient_only_reads_and_changes_their_own_profile(self):
        before = self.patient.get("/api/v1/patients/me", **self.bearer)
        self.assertEqual(before.status_code, 200, before.content)
        self.assertEqual(before.json()["data"]["patient_id"], "1")
        patch = self.patient.patch(
            "/api/v1/patients/me", {"emergency_phone": "00000012345", "patient_id": "2"},
            content_type="application/json", **self.bearer,
        )
        self.assertEqual(patch.status_code, 200, patch.content)
        self.assertEqual(Patient.objects.get(pk=1).emergency_phone, "00000012345")
        self.assertNotEqual(Patient.objects.get(pk=2).emergency_phone, "00000012345")

    def test_front_desk_registers_and_finds_patient_only_in_its_store(self):
        profile = {
            "full_name": "合成代办患者",
            "birth_date": "2000-01-01",
            "billing_address": "合成账单地址",
            "phone": "00000000018",
            "emergency_name": "合成紧急联系人",
            "emergency_phone": "00000000019",
        }
        denied = self.front.post("/api/v1/clinics/2/patients", profile, content_type="application/json")
        self.assertIn(denied.status_code, (403, 404))
        created = self.front.post("/api/v1/clinics/1/patients", profile, content_type="application/json")
        self.assertEqual(created.status_code, 201, created.content)
        search = self.front.get("/api/v1/clinics/1/patients", {"q": profile["phone"]}).json()["data"]["items"]
        self.assertEqual(len(search), 1)
        self.assertEqual(search[0]["patient_id"], created.json()["data"]["patient_id"])
        self.assertNotIn("billing_address", search[0])
        self.assertNotIn("emergency_phone", search[0])

    def reserve_first_slot(self, key_name):
        treatment = TreatmentType.objects.create(
            treatment_code="ADC-BOOKABLE", treatment_name="合成初诊检查", standard_unit="次",
            default_slot_minutes=30, required_chair_kind="GENERAL",
        )
        chair = DentalChair.objects.create(clinic_id=1, chair_no="A-G01")
        shift = Shift.objects.create(
            clinic_id=1, dentist_id=1, status="PUBLISHED",
            start_at="2030-10-18T09:00:00+08:00", end_at="2030-10-18T10:00:00+08:00",
        )
        options = self.patient.get("/api/v1/booking/options", {
            "clinic_id": "1", "date": "2030-10-18", "treatment_type_id": str(treatment.pk),
        }, **self.bearer)
        self.assertEqual(options.status_code, 200, options.content)
        candidate = options.json()["data"]["items"][0]
        self.assertEqual(candidate["shift_id"], str(shift.pk))
        key = {**self.bearer, "HTTP_IDEMPOTENCY_KEY": key_name}
        payload = {key: candidate[key] for key in ("clinic_id", "dentist_id", "shift_id", "treatment_type_id", "start_at", "end_at")}
        first = self.patient.post("/api/v1/holds", payload, content_type="application/json", **key)
        self.assertEqual(first.status_code, 201, first.content)
        return chair, first.json()["data"], payload, key

    def test_patient_reads_candidates_and_reuses_the_same_ten_minute_hold_by_action(self):
        _, hold, payload, key = self.reserve_first_slot("booking-contract-hold")
        self.assertEqual(hold["payment"]["amount"], "50.00")
        self.assertEqual(
            datetime.fromisoformat(hold["expires_at"]) - datetime.fromisoformat(hold["server_time"]),
            timedelta(minutes=10),
        )
        repeated = self.patient.post("/api/v1/holds", payload, content_type="application/json", **key)
        self.assertEqual(repeated.status_code, 200, repeated.content)
        self.assertEqual(repeated.json()["data"]["claim_id"], hold["claim_id"])
        found = self.patient.get("/api/v1/holds/by-action", {"clinic_id": "1"}, **key)
        self.assertEqual(found.json()["data"]["claim_id"], hold["claim_id"])
        self.assertEqual(found.json()["data"]["status"], "HOLD")
        mismatch = self.patient.post(
            "/api/v1/holds", {**payload, "special_requirement": "合成不同载荷"}, content_type="application/json", **key,
        )
        self.assertEqual(mismatch.status_code, 409, mismatch.content)
        self.assertEqual(mismatch.json()["error"]["code"], "IDEMPOTENCY_CONFLICT")

    def test_front_desk_can_start_an_uninitiated_deposit_and_recover_a_late_result(self):
        _, hold, _, _ = self.reserve_first_slot("front-deposit-projection")
        deposit_id = hold["payment"]["deposit_id"]
        url = "/api/v1/deposit-payments/" + deposit_id
        self.assertEqual(hold["payment"]["status"], "NOT_STARTED")
        result = self.front.get(url)
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json()["data"]["status"], "NOT_STARTED")
        with override_settings(ADC_SIMULATION_OUTCOMES={"deposit": "DEFERRED"}):
            with self.captureOnCommitCallbacks(execute=True):
                queued = self.front.post(url + "/simulate", {}, content_type="application/json")
            self.assertEqual(queued.status_code, 202, queued.content)
            self.assertEqual(queued.json()["data"]["status"], "PENDING")
        visible = self.front.get("/api/v1/holds/" + hold["claim_id"]).json()["data"]
        self.assertEqual(visible["payment"]["status"], "PENDING")
        released = self.front.post("/api/v1/holds/" + hold["claim_id"] + "/release", {}, content_type="application/json")
        self.assertEqual(released.status_code, 200, released.content)
        self.assertEqual(released.json()["data"]["status"], "RELEASED")
        with self.captureOnCommitCallbacks(execute=True):
            call_command("replay_simulated_funds")
        result = self.front.get(url).json()["data"]
        self.assertEqual(result["status"], "PAID")
        self.assertIsNone(result["appointment_id"])
        self.assertEqual(result["refund"]["amount"], "50.00")
        self.assertEqual(result["refund"]["status"], "SUCCEEDED")

    def test_successful_simulated_payment_forms_one_authorized_appointment(self):
        _, hold, _, _ = self.reserve_first_slot("booking-payment-hold")
        payment_id = hold["payment"]["deposit_id"]
        url = "/api/v1/deposit-payments/" + payment_id
        with self.captureOnCommitCallbacks(execute=True):
            payment = self.patient.post(url + "/simulate", {}, content_type="application/json", **self.bearer)
            self.assertIn(payment.status_code, (200, 202), payment.content)
        details = self.patient.get(url, **self.bearer).json()["data"]
        self.assertEqual(details["status"], "PAID")
        appointment_id = details["appointment_id"]
        self.assertIsNotNone(appointment_id)
        detail = self.patient.get("/api/v1/appointments/" + appointment_id, **self.bearer).json()["data"]
        self.assertEqual(detail["appointment_no"], details["appointment_no"])
        self.assertEqual(detail["clinic"]["clinic_id"], "1")
        with self.captureOnCommitCallbacks(execute=True):
            self.patient.post(url + "/simulate", {}, content_type="application/json", **self.bearer)
        result = self.patient.get("/api/v1/appointments", **self.bearer).json()["data"]["items"]
        self.assertEqual([item["appointment_id"] for item in result], [appointment_id])

    def test_success_after_chair_loss_releases_hold_and_refunds_without_appointing(self):
        chair, hold, _, _ = self.reserve_first_slot("booking-failed-resource-hold")
        DentalChairUnavailability.objects.create(
            chair=chair, start_at="2030-10-18T09:05:00+08:00", end_at="2030-10-18T09:20:00+08:00",
            reason="合成停用",
        )
        payment_id = hold["payment"]["deposit_id"]
        url = "/api/v1/deposit-payments/" + payment_id
        with self.captureOnCommitCallbacks(execute=True):
            response = self.patient.post(url + "/simulate", {}, content_type="application/json", **self.bearer)
            self.assertIn(response.status_code, (200, 202), response.content)
        data = self.patient.get(url, **self.bearer).json()["data"]
        self.assertEqual(data["status"], "PAID")
        self.assertIsNone(data["appointment_id"])
        self.assertEqual(data["claim_status"], "RELEASED")
        self.assertEqual(data["refund"]["amount"], "50.00")

    @override_settings(ADC_WORK_CALENDARS_PATH=str(Path(__file__).resolve().parents[1] / "fixtures" / "work_calendars.json"))
    def test_partial_overlap_changes_only_the_current_claim_preserving_number_and_deposit(self):
        _, hold, payload, _ = self.reserve_first_slot("reschedule-original")
        deposit_id = hold["payment"]["deposit_id"]
        with self.captureOnCommitCallbacks(execute=True):
            paid = self.patient.post(
                "/api/v1/deposit-payments/" + deposit_id + "/simulate", {},
                content_type="application/json", **self.bearer,
            )
            self.assertIn(paid.status_code, (200, 202), paid.content)
        original = Appointment.objects.get(deposit_id=deposit_id)
        candidate = self.patient.get("/api/v1/booking/options", {
            "clinic_id": "1", "treatment_type_id": payload["treatment_type_id"],
            "date": "2030-10-18", "appointment_id": str(original.pk),
            "preferred_start_at": "2030-10-18T09:15:00+08:00",
        }, **self.bearer)
        self.assertEqual(candidate.status_code, 200, candidate.content)
        self.assertEqual(len(candidate.json()["data"]["items"]), 1)
        route = f"/api/v1/appointments/{original.pk}/reschedule"
        fields = {
            **payload, "start_at": "2030-10-18T09:15:00+08:00", "end_at": "2030-10-18T09:45:00+08:00",
            "expected_claim_id": hold["claim_id"], "cause": "PATIENT", "reason": "合成改期",
        }
        stale_snapshot = Appointment.objects.select_related("claim").get(pk=original.pk)
        headers = {"HTTP_IDEMPOTENCY_KEY": "reschedule-original-action", **self.bearer}
        response = self.patient.post(route, fields, content_type="application/json", **headers)
        self.assertEqual(response.status_code, 200, response.content)
        current = response.json()["data"]
        self.assertNotEqual(current["claim_id"], hold["claim_id"])
        self.assertEqual(current["appointment_no"], original.appointment_no)
        self.assertEqual(current["deposit"]["deposit_id"], deposit_id)
        self.assertEqual(SlotClaim.objects.get(pk=hold["claim_id"]).status, "RELEASED")
        self.assertEqual(AppointmentChange.objects.get(appointment=original).old_claim_id, int(hold["claim_id"]))
        # A concurrent request can reach the service with the claim loaded before the first commit.
        with patch("adc.booking.reschedule_api.get_object_or_404", return_value=stale_snapshot):
            replay = self.patient.post(route, fields, content_type="application/json", **headers)
            self.assertEqual(replay.status_code, 200, replay.content)
            result = replay.json()["data"]
            for field in ("appointment_no", "claim_id", "status", "deposit"):
                self.assertEqual(result[field], current[field])
            for field in ("start_at", "end_at"):
                self.assertEqual(datetime.fromisoformat(result[field]), datetime.fromisoformat(current[field]))
            changed_request = self.patient.post(
                route, {**fields, "reason": "不同的合成改期原因"}, content_type="application/json", **headers,
            )
            self.assertEqual(changed_request.status_code, 409)
            self.assertEqual(changed_request.json()["error"]["code"], "IDEMPOTENCY_CONFLICT")
            other_operation = self.patient.post(
                route, fields, content_type="application/json",
                HTTP_IDEMPOTENCY_KEY="a-new-action", **self.bearer,
            )
            self.assertEqual(other_operation.status_code, 409)
            self.assertEqual(other_operation.json()["error"]["code"], "STALE_APPOINTMENT")
        self.assertEqual(AppointmentChange.objects.filter(appointment=original).count(), 1)
        nonexistent_hold = "/api/v1/holds/" + current["claim_id"]
        self.assertEqual(self.patient.get(nonexistent_hold, **self.bearer).status_code, 404)
        self.assertEqual(self.patient.post(nonexistent_hold + "/release", {}, content_type="application/json", **self.bearer).status_code, 404)

    def test_ordinary_patient_cancellation_at_the_start_moves_to_review_without_changing_funds(self):
        _, hold, _, _ = self.reserve_first_slot("review-original")
        deposit_id = hold["payment"]["deposit_id"]
        with self.captureOnCommitCallbacks(execute=True):
            paid = self.patient.post(
                "/api/v1/deposit-payments/" + deposit_id + "/simulate", {},
                content_type="application/json", **self.bearer,
            )
            self.assertIn(paid.status_code, (200, 202), paid.content)
        original = Appointment.objects.get(deposit_id=deposit_id)
        route = "/api/v1/appointments/" + str(original.pk)
        started = datetime.fromisoformat("2030-10-18T09:00:00+08:00")
        with patch("adc.booking.cancellation_service.service_now", return_value=started):
            response = self.patient.post(
                route + "/cancel", {
                    "expected_claim_id": hold["claim_id"], "reason": "合成患者申请", "quoted_refund_amount": "0.00",
                }, content_type="application/json", HTTP_IDEMPOTENCY_KEY="review-original-action", **self.bearer,
            )
            self.assertEqual(response.status_code, 409, response.content)
            self.assertEqual(response.json()["error"]["code"], "CANCELLATION_REVIEW_REQUIRED")
            original.refresh_from_db()
            self.assertEqual(original.status, "CONFIRMED")
            reviewed = self.front.post(
                route + "/cancellation-review",
                {"expected_claim_id": hold["claim_id"], "conclusion": "CONTINUE", "reason": "合成继续履约"},
                content_type="application/json", HTTP_IDEMPOTENCY_KEY="review-confirmed-action",
            )
            self.assertEqual(reviewed.status_code, 200, reviewed.content)
        self.assertEqual(self.patient.get(route, **self.bearer).json()["data"]["status"], "CONFIRMED")

    def test_staff_cross_clinic_change_requires_both_grants_and_exposes_only_old_store_evidence(self):
        _, hold, _, _ = self.reserve_first_slot("handover-original")
        with self.captureOnCommitCallbacks(execute=True):
            self.patient.post(
                "/api/v1/deposit-payments/" + hold["payment"]["deposit_id"] + "/simulate", {},
                content_type="application/json", **self.bearer,
            )
        original = Appointment.objects.get(deposit_id=hold["payment"]["deposit_id"])
        DentalChair.objects.create(clinic_id=2, chair_no="B-G01")
        new_shift = Shift.objects.create(
            clinic_id=2, dentist_id=1, status="PUBLISHED",
            start_at="2030-10-18T11:00:00+08:00", end_at="2030-10-18T12:00:00+08:00",
        )
        route = "/api/v1/appointments/" + str(original.pk)
        intent = self.front.post(route + "/coordination-intents", {
            "expected_claim_id": hold["claim_id"], "impact": "合成停诊", "patient_intent": "同意协商",
        }, content_type="application/json", HTTP_IDEMPOTENCY_KEY="handoff-intent")
        self.assertEqual(intent.status_code, 200, intent.content)
        original.refresh_from_db()
        self.assertEqual(original.claim_id, int(hold["claim_id"]))
        change = {
            "expected_claim_id": hold["claim_id"], "clinic_id": "2", "dentist_id": "1", "shift_id": str(new_shift.pk),
            "start_at": "2030-10-18T11:00:00+08:00", "end_at": "2030-10-18T11:30:00+08:00",
            "cause": "CLINIC", "reason": "合成停诊改期", "patient_consent_ref": "合成同意证据",
        }
        single = self.front.post(
            route + "/reschedule", change, content_type="application/json", HTTP_IDEMPOTENCY_KEY="handoff-one",
        )
        self.assertEqual(single.status_code, 403, single.content)
        scheduler = Client()
        sign_in = scheduler.post(
            "/api/v1/auth/web/login", {"login_identity": "demo.scheduler", "password": "booking-synthetic-password"},
            content_type="application/json",
        )
        self.assertEqual(sign_in.status_code, 200, sign_in.content)
        accepted = scheduler.post(
            route + "/reschedule", change, content_type="application/json", HTTP_IDEMPOTENCY_KEY="handoff-two",
        )
        self.assertEqual(accepted.status_code, 200, accepted.content)
        self.assertEqual(accepted.json()["data"]["clinic"]["clinic_id"], "2")
        self.assertEqual(self.front.get(route).status_code, 404)
        original_deposit = "/api/v1/deposit-payments/" + hold["payment"]["deposit_id"]
        self.assertEqual(self.front.get(original_deposit).status_code, 404)
        self.assertEqual(self.patient.get(original_deposit, **self.bearer).status_code, 200)
        evidence = self.front.get(route + "/handover-evidence").json()["data"]["items"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["origin_clinic_id"], "1")
        self.assertNotIn("new_start_at", evidence[0])
        self.assertNotIn("clinic", evidence[0])

    def test_recovery_replays_only_the_verified_ids(self):
        _, hold, payload, _ = self.reserve_first_slot("recover-selected")
        other = self.patient.post("/api/v1/holds", {
            **payload, "start_at": "2030-10-18T09:30:00+08:00", "end_at": "2030-10-18T10:00:00+08:00",
        }, content_type="application/json", HTTP_IDEMPOTENCY_KEY="recover-unselected", **self.bearer)
        self.assertEqual(other.status_code, 201, other.content)
        selected_id = hold["payment"]["deposit_id"]
        other_id = other.json()["data"]["payment"]["deposit_id"]
        with override_settings(ADC_SIMULATION_OUTCOMES={"deposit": "DEFERRED"}):
            with self.captureOnCommitCallbacks(execute=True):
                for payment_id in (selected_id, other_id):
                    result = self.patient.post(
                        "/api/v1/deposit-payments/" + payment_id + "/simulate", {},
                        content_type="application/json", **self.bearer,
                    )
                    self.assertEqual(result.status_code, 202, result.content)
        for _ in range(2):
            with self.captureOnCommitCallbacks(execute=True):
                call_command("replay_simulated_funds", "--obligation", "deposit:" + selected_id)
        self.assertEqual(Appointment.objects.filter(deposit_id=selected_id).count(), 1)
        pending = self.patient.get("/api/v1/deposit-payments/" + other_id, **self.bearer).json()["data"]
        self.assertEqual(pending["status"], "PENDING")
        self.assertFalse(Appointment.objects.filter(deposit_id=other_id).exists())

    def test_pending_simulation_replays_one_obligation_after_pause_is_cleared(self):
        _, hold, _, _ = self.reserve_first_slot("replay-original")
        payment_id = hold["payment"]["deposit_id"]
        url = "/api/v1/deposit-payments/" + payment_id
        with override_settings(ADC_SIMULATION_OUTCOMES={"deposit": "DEFERRED"}):
            with self.captureOnCommitCallbacks(execute=True):
                uncertain = self.patient.post(url + "/simulate", {}, content_type="application/json", **self.bearer)
                self.assertEqual(uncertain.status_code, 202, uncertain.content)
        with override_settings(ADC_SIMULATION_PAUSED=True):
            with self.assertRaises(CommandError):
                call_command("replay_simulated_funds")
        with self.captureOnCommitCallbacks(execute=True):
            call_command("replay_simulated_funds")
        with self.captureOnCommitCallbacks(execute=True):
            call_command("replay_simulated_funds")
        self.assertEqual(Appointment.objects.filter(deposit_id=payment_id).count(), 1)

    def test_no_show_starts_at_the_slot_end_and_requires_front_desk_verification(self):
        _, hold, _, _ = self.reserve_first_slot("manual-no-show-hold")
        with self.captureOnCommitCallbacks(execute=True):
            self.patient.post(
                "/api/v1/deposit-payments/" + hold["payment"]["deposit_id"] + "/simulate", {},
                content_type="application/json", **self.bearer,
            )
        original = Appointment.objects.get(deposit_id=hold["payment"]["deposit_id"])
        route = "/api/v1/appointments/" + str(original.pk) + "/no-show"
        end = datetime.fromisoformat(hold["end_at"])
        proof = {
            "expected_claim_id": hold["claim_id"], "reason": "合成人工核实",
            "patient_absent": True, "clinic_able": True,
        }
        with patch("adc.booking.cancellation_service.service_now", return_value=end - timedelta(minutes=1)):
            early = self.front.post(route, proof, content_type="application/json", HTTP_IDEMPOTENCY_KEY="manual-no-show-early")
            self.assertEqual(early.status_code, 409, early.content)
        with patch("adc.booking.cancellation_service.service_now", return_value=end):
            denied = self.patient.post(
                route, proof, content_type="application/json", HTTP_IDEMPOTENCY_KEY="manual-no-show-patient", **self.bearer,
            )
            self.assertEqual(denied.status_code, 403, denied.content)
            valid = self.front.post(route, proof, content_type="application/json", HTTP_IDEMPOTENCY_KEY="manual-no-show-finish")
            self.assertEqual(valid.status_code, 200, valid.content)
        self.assertEqual(valid.json()["data"]["status"], "NO_SHOW")
        self.assertEqual(valid.json()["data"]["refund"]["status"], "RETAINED")
