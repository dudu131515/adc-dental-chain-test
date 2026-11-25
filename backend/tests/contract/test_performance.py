from datetime import datetime, timedelta
from decimal import Decimal
from time import perf_counter

from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings

from adc.billing.models import Invoice
from adc.booking.models import Appointment, DepositPayment, SlotClaim
from adc.catalog.models import TreatmentType
from adc.clinical.models import DentistWorkSession, Material, MaterialUsage, TreatmentItem, Visit
from adc.identity.models import Employee
from adc.scheduling.models import Shift
from tests.fixtures.scenarios import load_synthetic_base


class PerformanceContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def setUp(self):
        password = "performance-synthetic-password"
        encoded = make_password(password)
        names = ("calculate", "review", "confirm", "manager-a", "reports", "dentist", "front-a")
        configuration = override_settings(ADC_STAFF_PASSWORD_HASHES={"demo." + name: encoded for name in names})
        configuration.enable()
        self.addCleanup(configuration.disable)
        self.accounts = {}
        for name in names:
            client = Client()
            login = client.post("/api/v1/auth/web/login", {
                "login_identity": "demo." + name, "password": password,
            }, content_type="application/json")
            self.assertEqual(login.status_code, 200, login.content)
            self.accounts[name] = client

    def post(self, actor, route, key, values=None):
        return self.accounts[actor].post(
            "/api/v1" + route, values or {}, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
        )

    def issued_visit(self, index, dentist, project, start, revenue, clinic=1):
        end = start + timedelta(minutes=30)
        shift = Shift.objects.create(clinic_id=clinic, dentist_id=dentist, start_at=start, end_at=end, status="PUBLISHED")
        claim = SlotClaim.objects.create(
            clinic_id=clinic, dentist_id=dentist, patient_id=1, shift=shift,
            requested_treatment_type=project, start_at=start, end_at=end, status="RELEASED",
        )
        original = DepositPayment.objects.create(claim=claim, status="PAID", paid_at=start)
        appointment = Appointment.objects.create(
            claim=claim, deposit=original, appointment_no="ADC-PERF-" + str(index), status="COMPLETED", is_attended=True,
        )
        visit = Visit.objects.create(
            appointment=appointment, main_dentist_id=dentist, started_at=start, ended_at=end, status="COMPLETED",
        )
        DentistWorkSession.objects.create(
            visit=visit, dentist_id=dentist, started_at=start, ended_at=end, duration_minutes=Decimal("30.00"),
        )
        return Invoice.objects.create(
            visit=visit, invoice_no="ADC-PERF-INV-" + str(index), original_total=revenue, status="ISSUED",
        )

    def prepare_period(self, *, expense=True):
        created = self.post("calculate", "/performance/periods", "performance-create-q", {"year": 2031, "quarter": 1})
        self.assertIn(created.status_code, (200, 201), created.content)
        period = created.json()["data"]["period_id"]
        project = TreatmentType.objects.create(
            treatment_code="ADC-PERF", treatment_name="合成项目", standard_unit="次", default_slot_minutes=30,
        )
        dentist_2 = Employee.objects.create(employee_no="PERF-2", full_name="合成二号牙医")
        dentist_3 = Employee.objects.create(employee_no="PERF-3", full_name="合成三号牙医")
        evidence = [
            (1, "2030-12-31T23:50:00+08:00", "120.00"),
            (dentist_2.pk, "2031-01-02T09:00:00+08:00", "100.00"),
            (dentist_3.pk, "2031-01-03T09:00:00+08:00", "50.00"),
        ]
        for index, (dentist, start, revenue) in enumerate(evidence, 1):
            invoice = self.issued_visit(index, dentist, project, datetime.fromisoformat(start), Decimal(revenue))
            if index == 1:
                self.original = invoice
        if expense:
            recorded = self.post("manager-a", "/expenses", "performance-expense", {
                "clinic_id": "1", "period_id": period, "expense_category": "合成共同费用",
                "amount": "0.02", "scope": "SHARED", "evidence_ref": "ADC-SYNTHETIC-PERF-01",
            })
            self.assertEqual(recorded.status_code, 201, recorded.content)
        return "/performance/periods/" + period

    def test_full_minutes_follow_end_quarter_and_fractional_residual_stays_unassigned(self):
        period = self.prepare_period()
        trial = self.post("calculate", period + "/calculate", "performance-trial")
        self.assertEqual(trial.status_code, 200, trial.content)
        data = trial.json()["data"]
        self.assertEqual(data["company"]["revenue"], "270.00")
        self.assertEqual(data["company"]["incentive_fund"], "27.00")
        self.assertEqual(data["unallocated_amount"], "0.02")
        self.assertEqual([item["basis_minutes"] for item in data["dentists"]], ["30.00"] * 3)
        self.assertEqual([item["operating_cost"] for item in data["dentists"]], ["0.00"] * 3)
        version = period + "/revisions/1"
        unauthorized = self.post("calculate", version + "/confirm", "performance-forbidden-confirm")
        self.assertEqual(unauthorized.status_code, 403, unauthorized.content)
        reviewed = self.post("review", version + "/review", "performance-review", {"decision": "APPROVED", "reason": "合成复核通过"})
        self.assertEqual(reviewed.status_code, 200, reviewed.content)
        confirmed = self.post("confirm", version + "/confirm", "performance-confirm")
        self.assertEqual(confirmed.status_code, 200, confirmed.content)
        self.assertEqual(confirmed.json()["data"]["status"], "CONFIRMED")

    def approve_version(self, period, revision):
        version = period + f"/revisions/{revision}"
        start = perf_counter()
        approved = self.post("review", version + "/review", f"review-{revision}", {
            "decision": "APPROVED", "reason": "合成版本审核通过",
        })
        self.assertEqual(approved.status_code, 200, approved.content)
        print(f"ADC quarter revision {revision} review {perf_counter() - start:.4f}s.")
        confirmed = self.post("confirm", version + "/confirm", f"confirm-{revision}")
        self.assertEqual(confirmed.status_code, 200, confirmed.content)
        return confirmed.json()["data"]

    def apply_adjustment(self, index, amount):
        invoice = self.original
        requested = self.post("dentist", f"/visits/{invoice.visit_id}/corrections", f"adjust-request-{index}", {
            "invoice_id": str(invoice.pk), "reason": "合成季度更正",
            "proposed_changes": {"summary": "更正应计", "signed_amount": amount},
        })
        self.assertEqual(requested.status_code, 201, requested.content)
        correction = "/corrections/" + requested.json()["data"]["correction_id"]
        approved = self.post("manager-a", correction + "/decision", f"adjust-approve-{index}", {
            "decision": "APPROVED", "reason": "合成更正确认",
        })
        self.assertEqual(approved.status_code, 200, approved.content)
        for key in (f"adjust-apply-{index}", f"adjust-repeat-{index}"):
            posted = self.post("front-a", correction + "/apply", key, {"invoice_id": str(invoice.pk)})
            self.assertEqual(posted.status_code, 200, posted.content)
        return posted.json()["data"]["adjustment_id"]

    def test_only_frozen_versions_are_official_and_adjustments_follow_sequence(self):
        period = self.prepare_period(expense=False)
        trial = self.post("calculate", period + "/calculate", "trial-original")
        self.assertEqual(trial.status_code, 200, trial.content)
        original = self.approve_version(period, 1)
        self.assertEqual(original["company"]["incentive_fund"], "27.00")
        first = self.apply_adjustment(2, "-120.00")
        second = self.apply_adjustment(3, "50.00")
        draft = self.post("calculate", period + "/calculate", "trial-revision-2")
        self.assertEqual(draft.status_code, 200, draft.content)
        self.assertEqual(draft.json()["data"]["source"]["adjustment_id"], first)
        ahead = self.post("confirm", period + "/revisions/3/confirm", "confirm-ahead")
        self.assertEqual(ahead.status_code, 409, ahead.content)
        official = self.accounts["reports"].get("/api/v1" + period)
        self.assertEqual(official.json()["data"]["latest_confirmed"]["revision_no"], 1)
        private = self.accounts["reports"].get("/api/v1" + period + "/revisions/2")
        self.assertEqual(private.status_code, 404, private.content)
        version_2 = self.approve_version(period, 2)
        self.assertEqual(version_2["company"]["incentive_fund"], "15.00")
        self.assertEqual(version_2["company_delta"]["incentive_fund"], "-12.00")
        third = self.post("calculate", period + "/calculate", "trial-revision-3")
        self.assertEqual(third.status_code, 200, third.content)
        self.assertEqual(third.json()["data"]["source"]["adjustment_id"], second)
        version_3 = self.approve_version(period, 3)
        self.assertEqual(version_3["company"]["incentive_fund"], "20.00")
        self.assertEqual(version_3["company_delta"]["incentive_fund"], "-7.00")
        official = self.accounts["reports"].get("/api/v1" + period + "/revisions")
        self.assertEqual([row["revision_no"] for row in official.json()["data"]["items"]], [1, 2, 3])
        replay = self.post("confirm", period + "/revisions/3/confirm", "confirm-3")
        self.assertEqual(replay.json()["data"]["confirmed_at"], version_3["confirmed_at"])

    def test_missing_minutes_review_return_and_zero_minute_loss(self):
        period = self.prepare_period(expense=False)
        work = DentistWorkSession.objects.get(visit_id=self.original.visit_id)
        work.delete()
        blocked = self.post("calculate", period + "/calculate", "trial-missing-minutes")
        self.assertEqual(blocked.json()["data"]["status"], "NEEDS_DATA")
        self.assertEqual(blocked.json()["data"]["missing"][0]["kind"], "WORK_MINUTES")
        work.save()
        trial = self.post("calculate", period + "/calculate", "trial-restored-minutes")
        self.assertEqual(trial.json()["data"]["status"], "REVIEW")
        returned = self.post("review", period + "/revisions/1/review", "review-returned", {
            "decision": "REJECTED", "reason": "补充凭据的核对结果",
        })
        self.assertEqual(returned.json()["data"]["status"], "RETURNED")
        early = self.post("confirm", period + "/revisions/1/confirm", "confirm-returned")
        self.assertEqual(early.status_code, 409, early.content)
        empty = self.post("calculate", "/performance/periods", "empty-quarter", {"year": 2031, "quarter": 2})
        empty_id = empty.json()["data"]["period_id"]
        expense = self.post("manager-a", "/expenses", "empty-shared", {
            "clinic_id": "1", "period_id": empty_id, "expense_category": "零分钟共同费用",
            "amount": "1.00", "scope": "SHARED", "evidence_ref": "ADC-ZERO-MINUTES",
        })
        self.assertEqual(expense.status_code, 201, expense.content)
        loss = self.post("calculate", f"/performance/periods/{empty_id}/calculate", "trial-empty")
        result = loss.json()["data"]
        self.assertEqual(result["company"]["net_profit"], "-1.00")
        self.assertEqual(result["company"]["incentive_fund"], "0.00")
        self.assertEqual(result["unallocated_amount"], "1.00")

    def test_cross_clinic_contributions_keep_actual_material_and_direct_expense_sources(self):
        period = self.prepare_period(expense=False)
        project = self.original.visit.appointment.claim.requested_treatment_type
        second = self.issued_visit(
            4, 1, project, datetime.fromisoformat("2031-01-04T10:00:00+08:00"), Decimal("30.00"), clinic=2,
        )
        material = Material.objects.create(material_code="ADC-EXPENSE-MATERIAL", material_name="合成耗材", standard_unit="件")
        item = TreatmentItem.objects.create(
            visit=second.visit, treatment_type=project, performing_dentist_id=1, units=1, unit_name_snapshot="次",
            unit_price_snapshot=30, amount=30,
        )
        MaterialUsage.objects.create(treatment_item=item, material=material, quantity="2.500", unit_cost_snapshot="4.00")
        expense_fields = {
            "clinic_id": "1", "period_id": period.rsplit("/", 1)[-1], "expense_category": "合成直接费用",
            "amount": "5.00", "scope": "DIRECT", "dentist_id": "1", "evidence_ref": "ADC-DIRECT-PERFORMANCE",
        }
        refused = self.post("manager-a", "/expenses", "direct-wrong-clinic", {**expense_fields, "clinic_id": "2"})
        self.assertEqual(refused.status_code, 403, refused.content)
        recorded = self.post("manager-a", "/expenses", "direct-cost", expense_fields)
        self.assertEqual(recorded.status_code, 201, recorded.content)
        trial = self.post("calculate", period + "/calculate", "trial-two-offices")
        self.assertEqual(trial.status_code, 200, trial.content)
        data = trial.json()["data"]
        dentist = {row["clinic_id"]: row for row in data["dentists"] if row["dentist_id"] == "1"}
        self.assertEqual(dentist["1"]["operating_cost"], "5.00")
        self.assertEqual(dentist["2"]["material_cost"], "10.00")
        self.assertEqual(dentist["2"]["basis_minutes"], "30.00")
        self.assertEqual(data["company"]["net_profit"], "285.00")
        self.assertEqual(data["company"]["incentive_fund"], "28.50")
