from dataclasses import replace
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from adc.booking.models import Appointment, DepositPayment, SlotClaim
from adc.billing.models import InvoicePayment
from adc.billing.refund_service import receive_refund, refund_operation
from adc.catalog.models import TreatmentType
from adc.clinical.models import TreatmentItem, Visit
from adc.identity.models import AppRole, AuditLog, EmployeeRole
from adc.common.http import ApiProblem
from adc.payments.simulator import SimulatedGateway
from adc.scheduling.models import Shift
from tests.fixtures.scenarios import load_synthetic_base


class BillingContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def setUp(self):
        password = "billing-synthetic-password"
        encoded = make_password(password)
        config = override_settings(ADC_STAFF_PASSWORD_HASHES={
            "demo.front-a": encoded, "demo.dentist": encoded, "demo.manager-a": encoded, "demo.front-b": encoded,
        })
        config.enable()
        self.addCleanup(config.disable)
        self.front = self.login("front-a", password)
        self.dentist = self.login("dentist", password)
        self.supervisor = self.login("manager-a", password)
        self.other_store = self.login("front-b", password)

    def login(self, name, password):
        client = Client()
        login = client.post("/api/v1/auth/web/login", {
            "login_identity": "demo." + name, "password": password,
        }, content_type="application/json")
        self.assertEqual(login.status_code, 200, login.content)
        return client

    def post(self, client, route, key, body=None):
        return client.post(
            "/api/v1" + route, body or {}, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
        )

    def finished_visit(self, *, zero=False):
        project = TreatmentType.objects.create(
            treatment_code="ADC-BILLING", treatment_name="合成洁牙", standard_unit="次", default_slot_minutes=60,
        )
        begin = timezone.now() - timedelta(hours=1)
        end = begin + timedelta(minutes=30)
        shift = Shift.objects.create(clinic_id=1, dentist_id=1, start_at=begin, end_at=end, status="PUBLISHED")
        claim = SlotClaim.objects.create(
            clinic_id=1, dentist_id=1, patient_id=1, shift=shift, requested_treatment_type=project,
            start_at=begin, end_at=end, status="RELEASED",
        )
        deposit = DepositPayment.objects.create(claim=claim, status="PAID", paid_at=begin)
        booking = Appointment.objects.create(
            claim=claim, deposit=deposit, status="COMPLETED", is_attended=True, appointment_no="ADC-BILLING-FIXTURE",
        )
        visit = Visit.objects.create(
            appointment=booking, main_dentist_id=1, started_at=begin, ended_at=end,
            status="TERMINATED" if zero else "COMPLETED", termination_reason="合成中止" if zero else None,
        )
        if not zero:
            item = TreatmentItem.objects.create(
                visit=visit, treatment_type=project, performing_dentist_id=1, units=Decimal("1"),
                unit_name_snapshot="次", unit_price_snapshot=Decimal("120.00"), amount=Decimal("120.00"),
            )
            AuditLog.objects.create(
                action="TREATMENT_ITEM_RECORDED", target_type="treatment_item", target_id=item.pk,
                after_value={"version": 1, "treatment_name": "合成洁牙"},
            )
        return visit

    def issued_invoice(self, *, zero=False):
        visit = self.finished_visit(zero=zero)
        path = "/visits/" + str(visit.pk) + "/invoice"
        issued = self.post(self.front, path, "issue-1")
        self.assertEqual(issued.status_code, 201, issued.content)
        invoice = issued.json()["data"]
        repeated = self.post(self.front, path, "issue-2")
        self.assertEqual(repeated.status_code, 200, repeated.content)
        self.assertEqual(repeated.json()["data"]["invoice_id"], invoice["invoice_id"])
        return visit, invoice

    def test_zero_treatment_termination_creates_one_zero_settled_invoice(self):
        _, invoice = self.issued_invoice(zero=True)
        self.assertEqual(invoice["original_total"], "0.00")
        self.assertEqual(invoice["lines"], [])
        self.assertEqual(invoice["status"], "SETTLED")

    def test_partial_collection_uses_one_successful_flow_and_excludes_deposit(self):
        _, invoice = self.issued_invoice()
        self.assertEqual(invoice["original_total"], "120.00")
        self.assertEqual(invoice["lines"][0]["treatment_name"], "合成洁牙")
        route = "/invoices/" + invoice["invoice_id"]
        denied = self.other_store.get("/api/v1" + route)
        self.assertIn(denied.status_code, (403, 404))
        with self.captureOnCommitCallbacks(execute=True):
            paid = self.post(self.front, route + "/payments", "pay-1", {"amount": "60.00"})
            self.assertIn(paid.status_code, (200, 201, 202), paid.content)
        result = self.front.get("/api/v1" + route).json()["data"]
        self.assertEqual(result["net_received"], "60.00")
        self.assertEqual(result["outstanding"], "60.00")
        self.assertEqual(result["status"], "PART_PAID")
        repeated = self.post(self.front, route + "/payments", "pay-1", {"amount": "60.00"})
        self.assertEqual(repeated.status_code, 200, repeated.content)
        self.assertEqual(self.front.get("/api/v1" + route).json()["data"]["net_received"], "60.00")

    def test_clerk_can_verify_the_approved_amount_before_posting(self):
        visit, invoice = self.issued_invoice()
        request = self.post(self.dentist, f"/visits/{visit.pk}/corrections", "different-proposal", {
            "invoice_id": invoice["invoice_id"], "reason": "合成更正",
            "proposed_changes": {"summary": "申请减额", "signed_amount": "-20.00"},
        })
        self.assertEqual(request.status_code, 201, request.content)
        self.assertNotIn("approval", request.json()["data"])
        correction = "/corrections/" + request.json()["data"]["correction_id"]
        decided = self.post(self.supervisor, correction + "/decision", "different-approved-amount", {
            "decision": "APPROVED", "reason": "合成核对", "approved_signed_amount": "-10.00",
        })
        self.assertEqual(decided.status_code, 200, decided.content)
        self.assertEqual(decided.json()["data"]["approval"].get("approved_signed_amount"), "-10.00")
        listed = self.front.get("/api/v1/corrections")
        self.assertEqual(listed.status_code, 200, listed.content)
        row, = listed.json()["data"]["items"]
        self.assertEqual(row["proposed_amount"], "-20.00")
        self.assertEqual(row["approval"].get("approved_signed_amount"), "-10.00")
        self.assertNotIn("reason", row["approval"])
        posted = self.post(self.front, correction + "/apply", "post-approved-amount", {"invoice_id": invoice["invoice_id"]})
        self.assertEqual(posted.status_code, 200, posted.content)
        self.assertEqual(posted.json()["data"]["signed_amount"], "-10.00")

    def test_front_desk_projection_with_a_dentist_grant_in_another_clinic(self):
        visit, invoice = self.issued_invoice()
        request = self.post(self.dentist, f"/visits/{visit.pk}/corrections", "mixed-projection", {
            "invoice_id": invoice["invoice_id"], "reason": "合成诊疗原因",
            "proposed_changes": {"summary": "合成诊疗摘要", "signed_amount": "-20.00"},
        })
        self.assertEqual(request.status_code, 201, request.content)
        dentist = visit.main_dentist_id
        clinic = visit.appointment.claim.clinic_id
        EmployeeRole.objects.filter(employee_id=dentist, role__role_code="DENTIST", scope_clinic_id=clinic).delete()
        EmployeeRole.objects.create(employee_id=dentist, role=AppRole.objects.get(role_code="FRONT_DESK"), scope_clinic_id=clinic)
        self.assertTrue(EmployeeRole.objects.filter(employee_id=dentist, role__role_code="DENTIST", scope_clinic_id=2).exists())
        result = self.dentist.get("/api/v1/corrections")
        self.assertEqual(result.status_code, 200, result.content)
        row, = result.json()["data"]["items"]
        self.assertEqual(row["proposed_amount"], "-20.00")
        self.assertNotIn("reason", row)
        self.assertNotIn("summary", row)

    def test_supervisor_can_read_only_payment_evidence_for_a_related_invoice(self):
        visit, invoice = self.issued_invoice()
        route = f"/invoices/{invoice['invoice_id']}/payments"
        with self.captureOnCommitCallbacks(execute=True):
            paid = self.post(self.front, route, "supervisor-readback", {"amount": "60.00"})
        self.assertIn(paid.status_code, (201, 202), paid.content)
        payment = paid.json()["data"]["payment"]
        read_path = "/api/v1" + route + "/" + payment["payment_id"]
        self.assertEqual(self.supervisor.get(read_path).status_code, 404)
        manager_grant = EmployeeRole.objects.create(
            employee_id=visit.main_dentist_id,
            role=AppRole.objects.get(role_code="CLINIC_MANAGER"), scope_clinic_id=visit.appointment.claim.clinic_id,
        )
        self.assertEqual(self.dentist.get(read_path).status_code, 403)
        manager_grant.delete()
        request = self.post(self.dentist, f"/visits/{visit.pk}/corrections", "related-correction", {
            "invoice_id": invoice["invoice_id"], "reason": "合成更正",
            "proposed_changes": {"summary": "申请减额", "signed_amount": "-20.00"},
        })
        self.assertEqual(request.status_code, 201, request.content)
        checked = self.supervisor.get(read_path)
        self.assertEqual(checked.status_code, 200, checked.content)
        self.assertEqual(checked.json()["data"]["payment_id"], payment["payment_id"])
        self.assertEqual(checked.json()["data"]["amount"], "60.00")
        self.assertEqual(self.dentist.get(read_path).status_code, 403)
        self.assertEqual(self.other_store.get(read_path).status_code, 404)
        write = self.post(self.supervisor, route, "supervisor-cannot-collect", {"amount": "10.00"})
        self.assertEqual(write.status_code, 403, write.content)

    def test_approved_reversal_preserves_the_invoice_and_refund_retries_same_original_flow(self):
        visit, invoice = self.issued_invoice()
        route = "/invoices/" + invoice["invoice_id"]
        with self.captureOnCommitCallbacks(execute=True):
            paid = self.post(self.front, route + "/payments", "reversal-pay", {"amount": "60.00"})
        source = paid.json()["data"]["payment"]["payment_id"]
        request = self.post(self.dentist, "/visits/" + str(visit.pk) + "/corrections", "reversal-apply", {
            "invoice_id": invoice["invoice_id"], "reason": "合成原单错误",
            "proposed_changes": {"summary": "冲销原单", "signed_amount": "-120.00"},
        })
        self.assertEqual(request.status_code, 201, request.content)
        correction = "/corrections/" + request.json()["data"]["correction_id"]
        attempted = self.post(self.front, correction + "/apply", "reversal-before", {"invoice_id": invoice["invoice_id"]})
        self.assertEqual(attempted.status_code, 409, attempted.content)
        decided = self.post(self.supervisor, correction + "/decision", "reversal-approve", {
            "decision": "APPROVED", "reason": "合成复核通过",
        })
        self.assertEqual(decided.status_code, 200, decided.content)
        posted = self.post(self.front, correction + "/apply", "reversal-post", {"invoice_id": invoice["invoice_id"]})
        self.assertEqual(posted.status_code, 200, posted.content)
        adjustment_id = posted.json()["data"]["adjustment_id"]
        corrected = self.front.get("/api/v1" + route).json()["data"]
        self.assertEqual(corrected["invoice_no"], invoice["invoice_no"])
        self.assertEqual(corrected["accrued"], "0.00")
        self.assertEqual(corrected["refund_due"], "60.00")
        by_action = "/api/v1" + route + "/refunds/by-action"
        self.assertEqual(self.front.get(by_action, HTTP_IDEMPOTENCY_KEY="reversal-refund").status_code, 404)
        with override_settings(ADC_SIMULATION_OUTCOMES={"invoice_refund": "FAILED"}):
            with self.captureOnCommitCallbacks(execute=True):
                refund = self.post(self.front, route + "/refunds", "reversal-refund", {
                    "source_payment_id": source, "adjustment_id": adjustment_id, "amount": "60.00",
                })
                self.assertIn(refund.status_code, (200, 201, 202), refund.content)
        refund_id = refund.json()["data"]["payment"]["payment_id"]
        recovered = self.front.get(by_action, HTTP_IDEMPOTENCY_KEY="reversal-refund")
        self.assertEqual(recovered.status_code, 200, recovered.content)
        self.assertEqual(recovered.json()["data"]["payment"]["payment_id"], refund_id)
        self.assertEqual(self.front.get(by_action, HTTP_IDEMPOTENCY_KEY="unknown-refund").status_code, 404)
        self.assertEqual(self.front.get("/api/v1" + route).json()["data"]["net_received"], "60.00")
        with self.captureOnCommitCallbacks(execute=True):
            retry = self.post(self.front, route + "/refunds/" + refund_id + "/retry", "reversal-retry")
            self.assertIn(retry.status_code, (200, 202), retry.content)
        latest = self.front.get("/api/v1" + route).json()["data"]
        self.assertEqual(latest["net_received"], "0.00")
        self.assertEqual([row["payment_id"] for row in latest["payments"] if row["kind"] == "REFUND"], [refund_id])
        original_refund = InvoicePayment.objects.get(pk=refund_id)
        adapter = SimulatedGateway()
        operation = refund_operation(original_refund)
        with self.assertRaises(ApiProblem):
            receive_refund(adapter.deliver(replace(operation, amount=Decimal("59.00"))))
        frozen = self.post(self.front, route + "/refunds/" + refund_id + "/retry", "reversal-frozen")
        self.assertEqual(frozen.status_code, 409, frozen.content)
        receive_refund(adapter.deliver(operation))
        with override_settings(ADC_SIMULATION_OUTCOMES={"invoice_refund": "FAILED"}):
            receive_refund(adapter.deliver(operation))
        self.assertEqual(self.front.get("/api/v1" + route).json()["data"]["net_received"], "0.00")

    def test_pending_refunds_reserve_limits_independently_for_two_successful_originals(self):
        visit, invoice = self.issued_invoice()
        route = "/invoices/" + invoice["invoice_id"]
        originals = []
        for index, value in enumerate(("50.00", "70.00")):
            with self.captureOnCommitCallbacks(execute=True):
                paid = self.post(self.front, route + "/payments", f"split-pay-{index}", {"amount": value})
            self.assertIn(paid.status_code, (201, 202), paid.content)
            originals.append(paid.json()["data"]["payment"]["payment_id"])
        request = self.post(self.dentist, "/visits/" + str(visit.pk) + "/corrections", "split-correction", {
            "invoice_id": invoice["invoice_id"], "reason": "合成整单冲销",
            "proposed_changes": {"summary": "冲销原单", "signed_amount": "-120.00"},
        })
        correction = "/corrections/" + request.json()["data"]["correction_id"]
        approved = self.post(self.supervisor, correction + "/decision", "split-approval", {"decision": "APPROVED", "reason": "同次复核"})
        self.assertEqual(approved.status_code, 200, approved.content)
        applied = self.post(self.front, correction + "/apply", "split-post", {"invoice_id": invoice["invoice_id"]})
        self.assertEqual(applied.status_code, 200, applied.content)
        with override_settings(ADC_SIMULATION_OUTCOMES={"invoice_refund": "DEFERRED"}):
            with self.captureOnCommitCallbacks(execute=True):
                refund = self.post(self.front, route + "/refunds", "reserve-first-origin", {
                    "source_payment_id": originals[0], "amount": "50.00",
                })
            self.assertEqual(refund.status_code, 202, refund.content)
            too_large = self.post(self.front, route + "/refunds", "exceeds-first-origin", {
                "source_payment_id": originals[0], "amount": "0.01",
            })
            self.assertEqual(too_large.status_code, 409, too_large.content)
            with self.captureOnCommitCallbacks(execute=True):
                second = self.post(self.front, route + "/refunds", "reserve-second-origin", {
                    "source_payment_id": originals[1], "amount": "70.00",
                })
            self.assertEqual(second.status_code, 202, second.content)
        current = self.front.get("/api/v1" + route).json()["data"]
        self.assertEqual(current["pending_refund"], "120.00")
        self.assertEqual(current["net_received"], "120.00")
        self.assertNotIn("refund", current["allowed_actions"])
