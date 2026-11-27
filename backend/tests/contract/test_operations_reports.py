from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings

from adc.billing.models import Invoice, InvoiceAdjustment, InvoiceLine, InvoicePayment, TreatmentCorrection
from adc.booking.models import Appointment, AppointmentChange, DepositPayment, SlotClaim
from adc.catalog.models import TreatmentType
from adc.clinical.models import DentistWorkSession, Material, MaterialUsage, TreatmentItem, Visit
from adc.identity.models import EmployeeRole
from adc.reporting.models import OperatingExpense, PerformancePeriod
from adc.scheduling.models import DentalChair, Shift
from tests.fixtures.scenarios import load_synthetic_base


class OperationsContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def make_appointment(self, shift, project, index, status, *, minutes=15, cancel_party=None):
        start = shift.start_at + timedelta(minutes=index * 45)
        active = status in {"CONFIRMED", "CHECKED_IN", "IN_TREATMENT"}
        attended = status in {"IN_TREATMENT", "COMPLETED"}
        claim = SlotClaim.objects.create(
            clinic_id=1, dentist_id=1, patient_id=1, shift=shift, requested_treatment_type=project,
            start_at=start, end_at=start + timedelta(minutes=minutes), status="CONFIRMED" if active else "RELEASED",
        )
        payment = DepositPayment.objects.create(claim=claim, status="PAID", paid_at=start - timedelta(days=1))
        appointment = Appointment.objects.create(
            claim=claim, deposit=payment, appointment_no=f"ADC-REPORT-{index}", status=status, is_attended=attended,
        )
        if attended:
            Visit.objects.create(
                appointment=appointment, main_dentist_id=1, started_at=start,
                ended_at=start + timedelta(minutes=5) if status == "COMPLETED" else None,
                status="COMPLETED" if status == "COMPLETED" else "IN_PROGRESS",
            )
        if cancel_party:
            AppointmentChange.objects.create(
                appointment=appointment, change_type="CANCEL", cancel_party=cancel_party, reason="合成取消",
            )
        if status == "NO_SHOW":
            AppointmentChange.objects.create(
                appointment=appointment, change_type="NO_SHOW", changed_by_id=2, reason="合成核实",
            )
        return appointment

    def login(self):
        client = Client()
        password = "synthetic-report-test"
        with override_settings(ADC_STAFF_PASSWORD_HASHES={"demo.reports": make_password(password)}):
            login = client.post(
                "/api/v1/auth/web/login", {"login_identity": "demo.reports", "password": password}, content_type="application/json",
            )
        self.assertEqual(login.status_code, 200, login.content)
        return client

    def test_shared_denominator_is_frozen_for_details_and_authorization_is_rechecked(self):
        project = TreatmentType.objects.create(treatment_code="ADC-REPORT", treatment_name="合成项目", standard_unit="次")
        start = datetime.fromisoformat("2031-06-03T08:00:00+08:00")
        shift = Shift.objects.create(clinic_id=1, dentist_id=1, start_at=start, end_at=start + timedelta(hours=9), status="PUBLISHED")
        for index in range(4):
            self.make_appointment(shift, project, index, "COMPLETED")
        self.make_appointment(shift, project, 4, "CANCELLED", cancel_party="PATIENT")
        self.make_appointment(shift, project, 5, "NO_SHOW")
        self.make_appointment(shift, project, 6, "CONFIRMED")
        waiting = self.make_appointment(shift, project, 7, "CHECKED_IN")
        self.make_appointment(shift, project, 8, "CANCELLED", cancel_party="CLINIC")
        early = self.make_appointment(shift, project, 9, "COMPLETED", minutes=40)
        client = self.login()
        params = {"date_from": "2031-06-03", "date_to": "2031-06-03", "clinic_ids": "1"}
        with patch("adc.reporting.operations_api.now", return_value=early.claim.end_at - timedelta(seconds=1)):
            response = client.get("/api/v1/reports/operations", params)
        self.assertEqual(response.status_code, 200, response.content)
        report = response.json()["data"]
        results = report["appointments"]
        self.assertEqual(results["denominator"], 8)
        self.assertEqual(results["attendance_rate"]["numerator"], 4)
        self.assertEqual(results["cancellation_rate"]["value"], "0.125")
        self.assertEqual((results["no_show"], results["unprocessed"], results["clinic_cancelled"]), (1, 2, 1))
        Appointment.objects.filter(pk=waiting.pk).update(status="NO_SHOW")
        filters = {"report_token": report["report_token"], "metric": "unprocessed", "clinic_id": "1"}
        details = client.get("/api/v1/reports/operations/details", filters)
        self.assertEqual(details.status_code, 200, details.content)
        self.assertEqual(len(details.json()["data"]["items"]), 2)
        self.assertIn("CHECKED_IN", [row["status"] for row in details.json()["data"]["items"]])
        self.assertNotIn("patient_id", details.json()["data"]["items"][0])
        with patch("adc.reporting.operations_api.now", return_value=early.claim.end_at):
            exact = client.get("/api/v1/reports/operations", params)
        self.assertEqual(exact.json()["data"]["appointments"]["attendance_rate"]["numerator"], 5)
        zero = client.get("/api/v1/reports/operations", {**params, "clinic_ids": "2"})
        self.assertEqual(zero.json()["data"]["appointments"]["attendance_rate"]["availability"], "NOT_APPLICABLE")
        EmployeeRole.objects.filter(employee_id=8, role__role_code="HQ_OPERATIONS_QUERY").update(scope_clinic_id=2)
        denied = client.get("/api/v1/reports/operations/details", filters)
        self.assertEqual(denied.status_code, 403, denied.content)

    def test_financial_report_uses_each_invoice_balance_and_successful_receipts(self):
        project = TreatmentType.objects.create(treatment_code="ADC-REPORT", treatment_name="合成计费项目", standard_unit="次")
        start = datetime.fromisoformat("2031-06-03T08:00:00+08:00")
        shift = Shift.objects.create(clinic_id=1, dentist_id=1, start_at=start, end_at=start + timedelta(hours=9), status="PUBLISHED")
        invoices = []
        for index, lines in enumerate((2, 1)):
            appointment = self.make_appointment(shift, project, index, "COMPLETED")
            visit = Visit.objects.get(appointment=appointment)
            if index == 1:
                visit.status, visit.termination_reason = "TERMINATED", "合成中止"
                visit.save(update_fields=("status", "termination_reason"))
            invoice = Invoice.objects.create(
                visit=visit, invoice_no=f"ADC-FINANCE-{index}", original_total=Decimal("60") * lines,
                status="ISSUED", issued_at=visit.ended_at if index == 0 else start + timedelta(hours=4),
            )
            for _ in range(lines):
                item = TreatmentItem.objects.create(
                    visit=visit, treatment_type=project, performing_dentist_id=1, units=1, unit_name_snapshot="次",
                    unit_price_snapshot=60, amount=60, recorded_at=visit.started_at,
                )
                InvoiceLine.objects.create(
                    invoice=invoice, treatment_item=item, treatment_name_snapshot="合成计费项目", unit_name_snapshot="次",
                    units=1, unit_price=60, subtotal=60,
                )
            invoices.append(invoice)
        original, unpaid = invoices
        correction = TreatmentCorrection.objects.create(
            visit=original.visit, requested_by_id=1, status="APPLIED", reason="合成更正",
            proposed_changes={"summary": "合成更正", "signed_amount": "-20.00"},
        )
        adjustment = InvoiceAdjustment.objects.create(
            invoice=original, correction=correction, signed_amount=-20, created_at=start + timedelta(minutes=90),
        )
        paid = InvoicePayment.objects.create(
            invoice=original, payment_kind="PAYMENT", amount=120, status="SUCCEEDED", idempotency_key="report-paid",
            paid_at=start + timedelta(hours=1),
        )
        for key, amount, status in (("succeeded", 10, "SUCCEEDED"), ("pending", 5, "PENDING")):
            InvoicePayment.objects.create(
                invoice=original, payment_kind="REFUND", amount=amount, status=status, source_payment=paid,
                adjustment=adjustment, idempotency_key="report-" + key,
                paid_at=start + timedelta(hours=2) if status == "SUCCEEDED" else None,
            )
        client = self.login()
        params = {"date_from": "2031-06-03", "date_to": "2031-06-03", "clinic_ids": "1", "dentist_ids": "1"}
        before_receipt = paid.paid_at - timedelta(microseconds=1)
        with patch("adc.reporting.operations_api.now", return_value=before_receipt):
            early = client.get("/api/v1/reports/operations", params)
        self.assertEqual(early.status_code, 200, early.content)
        early_report = early.json()["data"]
        self.assertEqual(early_report["as_of"], before_receipt.isoformat())
        self.assertEqual(early_report["financial"], {
            "accrued": "120.00", "received": "0.00", "refunded": "0.00", "net_received": "0.00", "outstanding": "120.00",
        })
        early_details = client.get("/api/v1/reports/operations/details", {
            "report_token": early_report["report_token"], "metric": "outstanding",
        })
        self.assertEqual(early_details.status_code, 200, early_details.content)
        self.assertEqual(
            [(row["invoice_id"], row["outstanding"]) for row in early_details.json()["data"]["items"]],
            [(str(original.pk), "120.00")],
        )
        with patch("adc.reporting.operations_api.now", return_value=paid.paid_at):
            exact = client.get("/api/v1/reports/operations", params)
        self.assertEqual(exact.status_code, 200, exact.content)
        self.assertEqual(exact.json()["data"]["financial"], {
            "accrued": "120.00", "received": "120.00", "refunded": "0.00", "net_received": "120.00", "outstanding": "0.00",
        })
        with patch("adc.reporting.operations_api.now", return_value=start + timedelta(hours=8)):
            response = client.get("/api/v1/reports/operations", params)
        self.assertEqual(response.status_code, 200, response.content)
        report = response.json()["data"]
        self.assertEqual(report["clinical"], {"actual_starts": 2, "normal_completions": 1, "actual_treatments": 3})
        self.assertEqual(report["standard_coverage"]["value"], "1")
        self.assertEqual(report["standard_coverage"]["denominator"], 3)
        self.assertEqual(report["financial"], {
            "accrued": "160.00", "received": "120.00", "refunded": "10.00", "net_received": "110.00", "outstanding": "60.00",
        })
        details = client.get("/api/v1/reports/operations/details", {"report_token": report["report_token"], "metric": "outstanding"})
        self.assertEqual([row["invoice_id"] for row in details.json()["data"]["items"]], [str(unpaid.pk)])

    def test_operating_overview_links_revenue_cost_workload_and_resource_use(self):
        project = TreatmentType.objects.create(treatment_code="ADC-OVERVIEW", treatment_name="合成经营项目", standard_unit="次")
        start = datetime.fromisoformat("2031-06-03T08:00:00+08:00")
        shift = Shift.objects.create(clinic_id=1, dentist_id=1, start_at=start, end_at=start + timedelta(hours=4), status="PUBLISHED")
        appointment = self.make_appointment(shift, project, 0, "COMPLETED")
        visit = Visit.objects.get(appointment=appointment)
        item = TreatmentItem.objects.create(
            visit=visit, treatment_type=project, performing_dentist_id=1, units=1, unit_name_snapshot="次",
            unit_price_snapshot=100, amount=100, recorded_at=start + timedelta(minutes=10),
        )
        material = Material.objects.create(material_code="ADC-OVERVIEW-MAT", material_name="合成耗材", standard_unit="克")
        MaterialUsage.objects.create(
            treatment_item=item, material=material, quantity=2, unit_cost_snapshot=10,
            material_name_snapshot=material.material_name, unit_name_snapshot=material.standard_unit,
        )
        invoice = Invoice.objects.create(
            visit=visit, invoice_no="ADC-OVERVIEW-INV", original_total=100, status="ISSUED", issued_at=visit.ended_at,
        )
        InvoicePayment.objects.create(
            invoice=invoice, payment_kind="PAYMENT", amount=100, status="SUCCEEDED", idempotency_key="overview-payment",
            paid_at=start + timedelta(minutes=20),
        )
        DentistWorkSession.objects.create(
            visit=visit, dentist_id=1, started_at=start, ended_at=start + timedelta(minutes=15), duration_minutes=15,
        )
        DentalChair.objects.create(clinic_id=1, chair_no="OVERVIEW-01")
        period = PerformancePeriod.objects.create(perf_year=2031, perf_quarter=2, status="OPEN")
        OperatingExpense.objects.create(
            clinic_id=1, period=period, expense_category="合成经营费用", amount=30, scope="SHARED",
        )
        client = self.login()
        cutoff = datetime.fromisoformat("2031-06-04T00:00:00+08:00")
        with patch("adc.reporting.operations_api.now", return_value=cutoff):
            response = client.get("/api/v1/reports/operations", {"date_from": "2031-06-03", "date_to": "2031-06-03", "clinic_ids": "1"})
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual(data["operations"]["revenue"], "100.00")
        self.assertEqual(data["operations"]["material_cost"], "20.00")
        self.assertEqual(data["operations"]["operating_cost"], "0.33")
        self.assertEqual(data["operations"]["net_profit"], "79.67")
        self.assertEqual(data["workload"]["total_minutes"], "15")
        self.assertEqual(data["resources"]["chair_utilization"]["numerator"], 15)
        self.assertEqual(data["resources"]["chair_utilization"]["denominator"], 240)
        self.assertEqual(data["clinics"][0]["revenue"], "100.00")
        self.assertEqual(data["trend"]["granularity"], "day")
        self.assertEqual(data["trend"]["points"][0]["revenue"], "100.00")
        details = client.get("/api/v1/reports/operations/details", {
            "report_token": data["report_token"], "metric": "material_cost",
        })
        self.assertEqual(details.json()["data"]["items"][0]["material_name"], "合成耗材")
        appointments = client.get("/api/v1/reports/operations/details", {
            "report_token": data["report_token"], "metric": "appointments",
        })
        self.assertEqual(appointments.json()["data"]["total"], 1)

        Shift.objects.create(
            clinic_id=1, dentist_id=2, start_at=start, end_at=start + timedelta(hours=2), status="PUBLISHED",
        )
        with patch("adc.reporting.operations_api.now", return_value=cutoff):
            filtered = client.get("/api/v1/reports/operations", {
                "date_from": "2031-06-03", "date_to": "2031-06-03", "clinic_ids": "1", "dentist_ids": "1",
            })
        self.assertEqual(filtered.status_code, 200, filtered.content)
        resources = filtered.json()["data"]["resources"]
        self.assertEqual(resources["dentist_utilization"]["denominator"], 240)
        self.assertEqual(resources["chair_utilization"]["denominator"], 240)
