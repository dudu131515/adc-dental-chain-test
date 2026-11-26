from datetime import datetime, timedelta, timezone
from decimal import Decimal

from django.contrib.auth.hashers import make_password
from django.db import connections
from django.test import Client, TestCase, override_settings

from adc.billing.models import Invoice, InvoiceLine, InvoicePayment
from adc.booking.models import Appointment, AppointmentChange, DepositPayment, DepositRefund, SlotClaim
from adc.catalog.models import TreatmentType
from adc.clinical.models import TreatmentItem, Visit
from adc.identity.models import AuditLog, EmployeeRole
from adc.scheduling.models import Shift
from scripts.grant_db_access import configure_access
from tests.fixtures.scenarios import load_synthetic_base


RECONCILIATION = "/api/v1/billing/reconciliation"
PATIENT_INVOICES = "/api/v1/patients/me/invoices"
BEFORE_LOCAL_MIDNIGHT = datetime(2026, 3, 3, 15, 58, tzinfo=timezone.utc)
AFTER_LOCAL_MIDNIGHT = BEFORE_LOCAL_MIDNIGHT + timedelta(minutes=4)


class FinanceReadContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()
        cls.project = TreatmentType.objects.create(
            treatment_code="ADC-FINANCE-TEST", treatment_name="合成项目", standard_unit="次", default_slot_minutes=60,
        )

    def setUp(self):
        self.claim_count = 0
        staff_names = ("front-a", "front-b", "manager-a", "dentist")
        password = "synthetic-finance-read-only-password"
        encoded = make_password(password)
        config = override_settings(
            ADC_STAFF_PASSWORD_HASHES={"demo." + name: encoded for name in staff_names},
            ADC_MINI_SYNTHETIC_CODES={"finance-a": "adc-demo-patient-a", "finance-b": "adc-demo-patient-b"},
        )
        config.enable()
        self.addCleanup(config.disable)
        self.front = self.staff("front-a", password)
        self.other_store = self.staff("front-b", password)
        self.supervisor = self.staff("manager-a", password)
        self.dentist = self.staff("dentist", password)

    def staff(self, name, password):
        client = Client()
        response = self.post(client, "/auth/web/login", {"login_identity": "demo." + name, "password": password})
        self.assertEqual(response.status_code, 200, response.content)
        return client

    def patient(self, suffix):
        client = Client()
        response = self.post(client, "/auth/mini/login", {"code": "finance-" + suffix})
        identity = response.json()["data"]
        self.assertEqual(identity.get("patient_id"), {"a": "1", "b": "2"}[suffix], response.content)
        return client, {"HTTP_AUTHORIZATION": "Bearer " + identity["token"]}

    def post(self, client, path, body, key="read-contract"):
        return client.post(
            "/api/v1" + path, body, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
        )

    def claim(self, clinic=1, patient=1):
        self.claim_count += 1
        begin = BEFORE_LOCAL_MIDNIGHT - timedelta(minutes=30 * self.claim_count)
        end = begin + timedelta(minutes=30)
        shift = Shift.objects.create(clinic_id=clinic, dentist_id=1, start_at=begin, end_at=end, status="PUBLISHED")
        return SlotClaim.objects.create(
            clinic_id=clinic, dentist_id=1, patient_id=patient, shift=shift, requested_treatment_type=self.project,
            start_at=begin, end_at=end, status="RELEASED",
        )

    def entry(self, **options):
        claim = self.claim(clinic=options.pop("clinic", 1), patient=options.pop("patient", 1))
        return DepositPayment.objects.create(claim=claim, **options)

    def refund(self, deposit, **options):
        return DepositRefund.objects.create(deposit=deposit, idempotency_key=f"refund-{deposit.pk}", **options)

    def visit_invoice(self, number, *, patient=1, clinic=1, deposit=None):
        claim = self.claim(clinic, patient) if deposit else None
        if not deposit:
            deposit = self.entry(clinic=clinic, patient=patient, status="PAID", paid_at=BEFORE_LOCAL_MIDNIGHT)
            claim = deposit.claim
        appointment = Appointment.objects.create(
            claim=claim, deposit=deposit, status="COMPLETED", is_attended=True, appointment_no=f"ADC-{number}",
        )
        visit = Visit.objects.create(
            appointment=appointment, main_dentist_id=1, started_at=claim.start_at, ended_at=claim.end_at,
            status="COMPLETED", clinical_notes="临床保密字段",
        )
        invoice = Invoice.objects.create(invoice_no=f"INV-{number}", visit=visit, original_total=Decimal("120.00"),
                                         status="ISSUED", issued_at=BEFORE_LOCAL_MIDNIGHT)
        return invoice

    def audit(self, target, action, at):
        AuditLog.objects.create(
            action=action, target_type=target._meta.db_table, target_id=target.pk, occurred_at=at,
            after_value={"private": "audit payload"},
        )

    def summary(self, client, clinic=1, day="2026-03-04"):
        response = client.get(RECONCILIATION, {"clinic_id": clinic, "date": day})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["data"]

    def test_cross_store_and_unpromoted_deposits_follow_original_claim_and_local_receipt_day(self):
        original = self.entry(status="PAID", paid_at=BEFORE_LOCAL_MIDNIGHT)
        invoice = self.visit_invoice("CROSS", clinic=2, deposit=original)
        appointment = invoice.visit.appointment
        AppointmentChange.objects.create(
            appointment=appointment, change_type="RESCHEDULE", old_claim=original.claim, new_claim=appointment.claim,
            changed_at=BEFORE_LOCAL_MIDNIGHT,
        )
        self.refund(original, refund_amount="25.00", reason="PATIENT_CANCELLATION", status="SUCCEEDED",
                    requested_at=BEFORE_LOCAL_MIDNIGHT, completed_at=AFTER_LOCAL_MIDNIGHT)
        unpromoted = self.entry(status="PAID", paid_at=AFTER_LOCAL_MIDNIGHT)
        returned = self.refund(unpromoted, refund_amount="50.00", reason="UNCONFIRMED_APPOINTMENT", status="SUCCEEDED",
                               requested_at=AFTER_LOCAL_MIDNIGHT, completed_at=AFTER_LOCAL_MIDNIGHT)
        retained = self.entry(status="PAID", paid_at=BEFORE_LOCAL_MIDNIGHT)
        self.refund(retained, refund_amount="0.00", reason="NO_SHOW", status="RETAINED", requested_at=AFTER_LOCAL_MIDNIGHT)
        InvoicePayment.objects.create(
            invoice=invoice, status="SUCCEEDED", payment_kind="PAYMENT", amount="120.00",
            idempotency_key="treatment-cross", paid_at=AFTER_LOCAL_MIDNIGHT,
        )

        day = self.summary(self.front)
        self.assertEqual(day["totals"], {
            "deposit_received": "50.00", "deposit_refunded": "75.00", "deposit_net": "-25.00",
            "treatment_received": "0.00", "treatment_refunded": "0.00", "treatment_net": "0.00",
        })
        self.assertEqual(len(day["settled"]), 3)
        self.assertTrue(all(row["clinic_id"] == "1" for row in day["settled"]))
        self.assertEqual(day["retained"][0]["retained_amount"], "50.00")
        self.assertEqual(day["retained"][0]["reason"], "NO_SHOW")
        unpromoted_row, = [row for row in day["settled"] if row["kind"] == "DEPOSIT_REFUND" and row["id"] == str(returned.pk)]
        self.assertEqual(unpromoted_row["claim_id"], str(unpromoted.claim_id))
        self.assertIsNone(unpromoted_row["source"])
        crossed, = [row for row in day["settled"] if row["reason"] == "PATIENT_CANCELLATION"]
        self.assertEqual(crossed["retained_amount"], "25.00")
        self.assertEqual(crossed["source"], {"kind": "handover", "id": str(appointment.pk)})
        self.assertNotIn("invoice_id", crossed)
        yesterday = self.summary(self.front, day="2026-03-03")
        self.assertEqual(yesterday["totals"]["deposit_received"], "100.00")
        self.assertEqual(yesterday["totals"]["deposit_refunded"], "0.00")
        destination = self.summary(self.other_store, clinic=2)
        self.assertEqual(destination["totals"]["deposit_received"], "0.00")
        self.assertEqual(destination["totals"]["deposit_refunded"], "0.00")
        self.assertEqual(destination["totals"]["treatment_net"], "120.00")
        self.assertEqual(destination["settled"][0]["source"], {"kind": "invoice", "id": str(invoice.pk)})

    def test_historical_day_keeps_pending_separate_and_retries_keep_initial_timestamp(self):
        deposit = self.entry(status="PENDING", payment_token="known-in-flight")
        self.audit(deposit, "DEPOSIT_SIMULATION_REQUESTED", BEFORE_LOCAL_MIDNIGHT)
        no_timestamp = self.entry(status="PENDING", payment_token="legacy-in-flight")
        self.entry(status="PENDING")
        paid = self.entry(status="PAID", paid_at=AFTER_LOCAL_MIDNIGHT)
        refund = self.refund(paid, refund_amount="50.00", reason="UNCONFIRMED_APPOINTMENT", status="PENDING",
                             requested_at=AFTER_LOCAL_MIDNIGHT)
        self.audit(refund, "DEPOSIT_REFUND_RETRIED", AFTER_LOCAL_MIDNIGHT + timedelta(days=1))
        invoice = self.visit_invoice("PENDING")
        collected = InvoicePayment.objects.create(
            invoice=invoice, status="SUCCEEDED", payment_kind="PAYMENT", amount="60.00",
            idempotency_key="pending-source", paid_at=BEFORE_LOCAL_MIDNIGHT,
        )
        successful = InvoicePayment.objects.create(
            invoice=invoice, source_payment=collected, status="SUCCEEDED", payment_kind="REFUND", amount="5.00",
            idempotency_key="settled-refund", paid_at=AFTER_LOCAL_MIDNIGHT,
        )
        treatment_refund = InvoicePayment.objects.create(
            invoice=invoice, source_payment=collected, status="PENDING", payment_kind="REFUND", amount="12.00",
            idempotency_key="pending-refund",
        )
        self.audit(treatment_refund, "INVOICE_REFUND_RECORDED", BEFORE_LOCAL_MIDNIGHT)
        self.audit(treatment_refund, "INVOICE_REFUND_RETRIED", AFTER_LOCAL_MIDNIGHT)
        self.audit(successful, "INVOICE_REFUND_RECORDED", BEFORE_LOCAL_MIDNIGHT)
        day = self.summary(self.supervisor, day="2026-03-05")
        self.assertEqual(day["settled"], [])
        self.assertTrue(day["historical"])
        rows = {(row["kind"], row["id"]): row for row in day["pending"]}
        self.assertEqual(len(rows), 4)
        for kind, item in (("DEPOSIT_PAYMENT", deposit), ("TREATMENT_REFUND", treatment_refund)):
            row = rows[kind, str(item.pk)]
            self.assertEqual(datetime.fromisoformat(row["requested_at"]), BEFORE_LOCAL_MIDNIGHT)
            self.assertTrue(row["cross_day"])
            self.assertIsNone(row["receipt_at"])
        treatment = rows["TREATMENT_REFUND", str(treatment_refund.pk)]
        self.assertIsNone(treatment["source"])
        self.assertNotIn("invoice_id", treatment)
        self.assertNotIn("source_payment_id", treatment)
        legacy = rows["DEPOSIT_PAYMENT", str(no_timestamp.pk)]
        self.assertIsNone(legacy["requested_at"])
        self.assertIsNone(legacy["cross_day"])
        before_request = self.summary(self.front, day="2026-03-02")
        after_selected_day, = [row for row in before_request["pending"] if row["id"] == str(deposit.pk)
                               and row["kind"] == "DEPOSIT_PAYMENT"]
        self.assertTrue(after_selected_day["cross_day"])
        day = self.summary(self.front)
        self.assertEqual(day["totals"]["treatment_received"], "0.00")
        self.assertEqual(day["totals"]["treatment_refunded"], "5.00")
        self.assertEqual(day["totals"]["treatment_net"], "-5.00")

    def test_reconciliation_denies_other_clinics_other_roles_and_revoked_session(self):
        query = {"clinic_id": "1", "date": "2026-03-04"}
        for staff in (self.other_store, self.dentist):
            self.assertEqual(staff.get(RECONCILIATION, query).status_code, 403)
        patient, bearer = self.patient("a")
        self.assertEqual(patient.get(RECONCILIATION, query, **bearer).status_code, 403)
        self.assertEqual(self.front.get(RECONCILIATION, query).status_code, 200)
        EmployeeRole.objects.filter(employee_id=2, scope_clinic_id=1).delete()
        self.assertEqual(self.front.get(RECONCILIATION, query).status_code, 403)
        self.assertEqual(self.supervisor.get(RECONCILIATION, {**query, "date": "2026-02-30"}).status_code, 400)

    def test_patient_invoice_projection_uses_successful_funds_and_applied_approval(self):
        invoice = self.visit_invoice("OWN")
        invoice_id = str(invoice.pk)
        other = self.visit_invoice("OTHER", patient=2)
        visit = invoice.visit
        item = TreatmentItem.objects.create(
            visit=visit, treatment_type=self.project, performing_dentist_id=1, units="2.000",
            unit_name_snapshot="次", unit_price_snapshot="60.00", amount="120.00",
        )
        InvoiceLine.objects.create(
            invoice=invoice, treatment_item=item, treatment_name_snapshot="冻结项目名", unit_name_snapshot="次",
            units="2.000", unit_price="60.00", subtotal="120.00",
        )
        payment = InvoicePayment.objects.create(
            invoice=invoice, status="SUCCEEDED", payment_kind="PAYMENT", amount="100.00",
            idempotency_key="secret-payment-key", paid_at=AFTER_LOCAL_MIDNIGHT,
        )
        for actor, amount, key, apply in ((self.supervisor, "-40.00", "applied", True),
                                          (self.supervisor, "-10.00", "unapplied", False)):
            correction = self.post(self.dentist, f"/visits/{visit.pk}/corrections", {
                "invoice_id": invoice_id, "reason": "保密更正原因",
                "proposed_changes": {"summary": "保密临床摘要", "signed_amount": amount},
            }, key=key + "-request")
            self.assertEqual(correction.status_code, 201, correction.content)
            route = "/corrections/" + correction.json()["data"]["correction_id"]
            approval = self.post(actor, route + "/decision", {
                "decision": "APPROVED", "reason": "保密审核说明", "approved_signed_amount": amount,
            }, key=key + "-decision")
            self.assertEqual(approval.status_code, 200, approval.content)
            if apply:
                posted = self.post(self.front, route + "/apply", {"invoice_id": invoice_id}, key=key)
                self.assertEqual(posted.status_code, 200, posted.content)
        for status, amount in (("SUCCEEDED", "5.00"), ("PENDING", "7.00"), ("FAILED", "8.00")):
            InvoicePayment.objects.create(
                invoice=invoice, source_payment=payment, payment_kind="REFUND", status=status, amount=amount,
                idempotency_key=f"secret-{status}", paid_at=AFTER_LOCAL_MIDNIGHT if status == "SUCCEEDED" else None,
            )
        patient, bearer = self.patient("a")
        response = patient.get(f"{PATIENT_INVOICES}/{invoice_id}", **bearer)
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual(data["invoice_no"], "INV-OWN")
        self.assertEqual(data["visit_date"], "2026-03-03")
        self.assertEqual(data["clinic"], {"clinic_id": "1", "name": "合成甲店"})
        self.assertEqual(data["lines"], [{"treatment_name": "冻结项目名", "unit": "次", "units": "2.000",
                                          "unit_price": "60.00", "subtotal": "120.00"}])
        self.assertEqual([row["signed_amount"] for row in data["adjustments"]], ["-40.00"])
        self.assertEqual(
            [data[key] for key in ("original_total", "accrued", "received", "refunded", "outstanding", "pending_refund")],
            ["120.00", "80.00", "100.00", "5.00", "0.00", "7.00"],
        )
        self.assertEqual([row["status"] for row in data["funds"]], ["SUCCEEDED", "SUCCEEDED", "PENDING"])
        for secret in ("clinical_notes", "correction_id", "payment_id", "source_payment_id", "idempotency_key", "patient_id", "deposit"):
            self.assertNotIn(secret, response.content.decode())
        listing = patient.get(PATIENT_INVOICES, {"appointment_id": str(visit.appointment_id)}, **bearer)
        self.assertEqual([row["invoice_id"] for row in listing.json()["data"]["items"]], [invoice_id])
        outside = patient.get(PATIENT_INVOICES, {"appointment_id": str(other.visit.appointment_id)}, **bearer)
        self.assertEqual(outside.json()["data"]["items"], [])
        self.assertEqual(patient.get(f"{PATIENT_INVOICES}/{other.pk}", **bearer).status_code, 404)
        self.assertEqual(patient.get(f"/api/v1/invoices/{invoice_id}/payments/{payment.pk}", **bearer).status_code, 403)
        self.assertEqual(self.front.get(PATIENT_INVOICES).status_code, 403)

    def test_patient_invoice_cursor_is_bound_to_patient_and_appointment_filter(self):
        older = self.visit_invoice("OLDER")
        newer = self.visit_invoice("NEWER")
        patient, bearer = self.patient("a")
        first = patient.get(PATIENT_INVOICES, {"limit": 1}, **bearer)
        self.assertEqual(first.status_code, 200, first.content)
        data = first.json()["data"]
        self.assertEqual([row["invoice_id"] for row in data["items"]], [str(newer.pk)])
        second = patient.get(PATIENT_INVOICES, {"limit": 1, "cursor": data["next_cursor"]}, **bearer)
        self.assertEqual([row["invoice_id"] for row in second.json()["data"]["items"]], [str(older.pk)])
        self.assertIsNone(second.json()["data"]["next_cursor"])
        self.assertEqual(patient.get(
            PATIENT_INVOICES, {"cursor": data["next_cursor"], "appointment_id": older.visit.appointment_id}, **bearer,
        ).status_code, 400)
        other, other_bearer = self.patient("b")
        self.assertEqual(other.get(PATIENT_INVOICES, {"cursor": data["next_cursor"]}, **other_bearer).status_code, 400)


    def test_scoped_finance_reads_work_under_restricted_business_and_runtime_roles(self):
        invoice = self.visit_invoice("RESTRICTED")
        patient, bearer = self.patient("a")
        with connections["default"].cursor() as cursor:
            cursor.execute("CREATE ROLE adc_test_finance_business_app NOLOGIN")
            configure_access(cursor, "business", "adc_test_finance_business_app")
            cursor.execute("SET LOCAL ROLE adc_test_finance_business_app")
        with connections["runtime"].cursor() as cursor:
            cursor.execute("CREATE ROLE adc_test_finance_runtime_app NOLOGIN")
            configure_access(cursor, "runtime", "adc_test_finance_runtime_app")
            cursor.execute("SET LOCAL ROLE adc_test_finance_runtime_app")

        reconciliation = self.summary(self.front, day="2026-03-03")
        self.assertEqual(reconciliation["totals"]["deposit_received"], "50.00")
        self.assertEqual(self.other_store.get(RECONCILIATION, {"clinic_id": 1, "date": "2026-03-03"}).status_code, 403)
        listed = patient.get(PATIENT_INVOICES, **bearer)
        self.assertEqual(listed.status_code, 200, listed.content)
        self.assertEqual(listed.json()["data"]["items"][0]["invoice_id"], str(invoice.pk))
        detail = patient.get(f"{PATIENT_INVOICES}/{invoice.pk}", **bearer)
        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(detail.json()["data"]["outstanding"], "120.00")

    def test_refund_due_shows_failed_deposits_and_unreserved_treatment_balances_once(self):
        deposit = self.entry(status="PAID", paid_at=BEFORE_LOCAL_MIDNIGHT)
        failed = self.refund(deposit, refund_amount="50.00", reason="VISIT_STARTED", status="FAILED",
                             requested_at=BEFORE_LOCAL_MIDNIGHT)
        invoice = self.visit_invoice("REFUND-DUE")
        collected = InvoicePayment.objects.create(
            invoice=invoice, status="SUCCEEDED", payment_kind="PAYMENT", amount="150.00",
            idempotency_key="due-original", paid_at=BEFORE_LOCAL_MIDNIGHT,
        )
        unattempted = self.visit_invoice("NO-ATTEMPT")
        InvoicePayment.objects.create(
            invoice=unattempted, status="SUCCEEDED", payment_kind="PAYMENT", amount="140.00",
            idempotency_key="due-untouched", paid_at=BEFORE_LOCAL_MIDNIGHT,
        )
        for status, amount in (("FAILED", "12.00"), ("PENDING", "8.00"), ("SUCCEEDED", "5.00")):
            InvoicePayment.objects.create(
                invoice=invoice, source_payment=collected, payment_kind="REFUND", status=status, amount=amount,
                idempotency_key=f"due-{status}", paid_at=AFTER_LOCAL_MIDNIGHT if status == "SUCCEEDED" else None,
            )
        current = self.summary(self.front, day="2026-03-02")
        self.assertEqual(current["settled"], [])
        deposit_due, = [row for row in current["refund_due"] if row["kind"] == "DEPOSIT_REFUND"]
        self.assertEqual((deposit_due["id"], deposit_due["amount"], deposit_due["reason"], deposit_due["claim_id"]),
                         (str(failed.pk), "50.00", "VISIT_STARTED", str(deposit.claim_id)))
        treatments = {
            row["source"]["id"]: row["amount"] for row in current["refund_due"] if row["kind"] == "TREATMENT_REFUND_DUE"
        }
        self.assertEqual(treatments, {str(invoice.pk): "17.00", str(unattempted.pk): "20.00"})
        self.assertEqual([row["amount"] for row in current["pending"]], ["8.00"])
        supervisor = self.summary(self.supervisor, day="2026-03-02")
        for row in supervisor["refund_due"]:
            if row["kind"] == "TREATMENT_REFUND_DUE":
                self.assertIsNone(row["id"])
                self.assertIsNone(row["source"])
                self.assertNotIn("invoice_id", row)
        failed.status = "PENDING"
        failed.save(update_fields=["status"])
        after_retry = self.summary(self.front, day="2026-03-02")
        self.assertNotIn("DEPOSIT_REFUND", [row["kind"] for row in after_retry["refund_due"]])
        self.assertIn("DEPOSIT_REFUND", [row["kind"] for row in after_retry["pending"]])

    def test_correction_supervisor_gets_exact_existing_payment_evidence(self):
        invoice = self.visit_invoice("SUPERVISOR")
        issued = InvoicePayment.objects.create(
            invoice=invoice, status="SUCCEEDED", payment_kind="PAYMENT", amount="130.00",
            idempotency_key="supervisor-evidence", paid_at=AFTER_LOCAL_MIDNIGHT,
        )
        no_approval = self.summary(self.supervisor)
        self.assertIsNone(no_approval["settled"][0]["source"])
        self.assertIsNone(no_approval["refund_due"][0]["source"])
        correction = self.post(self.dentist, f"/visits/{invoice.visit_id}/corrections", {
            "invoice_id": str(invoice.pk), "reason": "合成需主管核对",
            "proposed_changes": {"summary": "合成费用差异", "signed_amount": "-5.00"},
        })
        self.assertEqual(correction.status_code, 201, correction.content)
        result = self.summary(self.supervisor)
        self.assertEqual(result["settled"][0]["source"],
                         {"kind": "payment", "invoice_id": str(invoice.pk), "id": str(issued.pk)})
        expected_source = {"kind": "invoice", "id": str(invoice.pk)}
        self.assertEqual(result["refund_due"][0]["source"], expected_source)
        invoice_detail = self.supervisor.get(f"/api/v1/invoices/{invoice.pk}")
        self.assertEqual(invoice_detail.status_code, 200, invoice_detail.content)
        exact_payment = self.supervisor.get(f"/api/v1/invoices/{invoice.pk}/payments/{issued.pk}")
        self.assertEqual(exact_payment.status_code, 200, exact_payment.content)
        self.assertEqual(exact_payment.json()["data"]["payment_id"], str(issued.pk))

        for status in ("FAILED", "SUCCEEDED"):
            InvoicePayment.objects.create(
                invoice=invoice, source_payment=issued, status=status, payment_kind="REFUND", amount="5.00",
                idempotency_key=f"supervisor-failure-{status}",
                paid_at=AFTER_LOCAL_MIDNIGHT if status == "SUCCEEDED" else None,
            )
        after_resolution = self.summary(self.supervisor)
        self.assertEqual(after_resolution["refund_due"][0]["amount"], "5.00")
        self.assertEqual(after_resolution["refund_due"][0]["source"], expected_source)
