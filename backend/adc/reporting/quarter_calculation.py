from collections import defaultdict
from datetime import datetime
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

from django.db import connection
from django.utils import timezone

from adc.billing.invoice_service import ZERO, amount_data
from adc.billing.models import InvoiceAdjustment
from adc.clinical.models import DentistWorkSession, MaterialUsage, Visit
from adc.common.http import ApiProblem
from adc.reporting.expenses_api import expense_evidence
from adc.reporting.models import CompanyPerformance, DentistPerformance, ExpenseAllocation, OperatingExpense
from adc.reporting.period_locks import BUSINESS_ZONE


CENT = Decimal("0.01")
MONEY = ("revenue", "material_cost", "operating_cost", "net_profit")


def quarter_bounds(period):
    month = (period.perf_quarter - 1) * 3 + 1
    start = datetime(period.perf_year, month, 1, tzinfo=BUSINESS_ZONE)
    end = datetime(period.perf_year + (month == 10), (month + 2) % 12 + 1, 1, tzinfo=BUSINESS_ZONE)
    return start, end


def invoice_facts(start, end):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT f.visit_id, f.invoice_id, f.accrued_amount
            FROM invoice_reporting_fact f JOIN visit v ON v.visit_id = f.visit_id
            WHERE v.ended_at >= %s AND v.ended_at < %s
            ORDER BY f.visit_id
            """,
            [start, end],
        )
        return {visit: (invoice, accrued) for visit, invoice, accrued in cursor.fetchall()}


def material_sources(visit_ids):
    sources = defaultdict(list)
    for usage in MaterialUsage.objects.filter(treatment_item__visit_id__in=visit_ids).values(
        "pk", "treatment_item__visit_id", "treatment_item__performing_dentist_id", "material_id", "quantity",
        "unit_cost_snapshot",
    ).order_by("pk"):
        sources[usage["treatment_item__visit_id"]].append(usage)
    return sources


def work_sources(visit_ids):
    sources = defaultdict(list)
    for work in DentistWorkSession.objects.filter(visit_id__in=visit_ids).order_by("pk"):
        sources[work.visit_id].append(work)
    return sources


def visit_sources(period, totals, missing):
    start, end = quarter_bounds(period)
    visits = list(Visit.objects.filter(
        ended_at__gte=start, ended_at__lt=end, status__in=("COMPLETED", "TERMINATED"),
    ).values("pk", "appointment__claim__clinic_id", "main_dentist_id", "started_at", "ended_at").order_by("pk"))
    visit_ids = [row["pk"] for row in visits]
    bills = invoice_facts(start, end)
    work = work_sources(visit_ids)
    materials = material_sources(visit_ids)
    adjustments = defaultdict(list)
    for invoice, adjustment in InvoiceAdjustment.objects.filter(invoice__visit_id__in=visit_ids).order_by("pk").values_list(
        "invoice_id", "pk",
    ):
        adjustments[invoice].append(str(adjustment))
    proof = []
    for visit in visits:
        visit_id = visit["pk"]
        clinic = visit["appointment__claim__clinic_id"]
        dentist = visit["main_dentist_id"]
        invoice, accrued = bills.get(visit_id, (None, ZERO))
        result = {"visit_id": str(visit_id), "clinic_id": str(clinic), "dentist_id": str(dentist)}
        if invoice is None:
            missing.append({**result, "kind": "INVOICE", "message": "缺少诊疗主单。"})
        sessions = work.get(visit_id, [])
        if not any(
            row.dentist_id == dentist and row.started_at == visit["started_at"] and row.ended_at == visit["ended_at"]
            for row in sessions
        ):
            missing.append({**result, "kind": "WORK_MINUTES", "message": "缺少完整主诊实际分钟依据。"})
        totals[(clinic, dentist)]["revenue"] += accrued
        for row in sessions:
            totals[(clinic, row.dentist_id)]["basis_minutes"] += row.duration_minutes
        for row in materials.get(visit_id, []):
            totals[(clinic, row["treatment_item__performing_dentist_id"])]["material_cost"] += (
                row["quantity"] * row["unit_cost_snapshot"]
            )
        proof.append({
            **result, "ended_at": visit["ended_at"].isoformat(), "invoice_id": str(invoice) if invoice else None,
            "accrued": amount_data(accrued), "adjustment_ids": adjustments.get(invoice, []),
            "work_sessions": [{
                "work_id": str(row.pk), "dentist_id": str(row.dentist_id), "minutes": amount_data(row.duration_minutes),
            } for row in sessions],
            "materials": [{
                "usage_id": str(row["pk"]), "material_id": str(row["material_id"]),
                "dentist_id": str(row["treatment_item__performing_dentist_id"]),
                "quantity": format(row["quantity"], ".3f"), "unit_cost": amount_data(row["unit_cost_snapshot"]),
            } for row in materials.get(visit_id, [])],
        })
    return proof


def expense_sources(period, totals, missing):
    rows = list(OperatingExpense.objects.filter(period=period).order_by("pk"))
    evidence = expense_evidence([row.pk for row in rows])
    work_by_clinic = defaultdict(dict)
    for (clinic, dentist), result in sorted(totals.items()):
        if result["basis_minutes"] > 0:
            work_by_clinic[clinic][dentist] = result["basis_minutes"]
    proof = []
    for row in rows:
        base = {"expense_id": str(row.pk), "clinic_id": str(row.clinic_id)}
        evidence_ref = evidence.get(row.pk, {}).get("evidence_ref")
        if not evidence_ref:
            missing.append({**base, "kind": "EXPENSE_EVIDENCE", "message": "缺少运营费用凭据。"})
        minutes = work_by_clinic[row.clinic_id]
        denominator = sum(minutes.values(), ZERO)
        parts = (
            [(row.dentist_id, row.amount, None)] if row.scope == "DIRECT" else [
                (dentist, (row.amount * basis / denominator).quantize(CENT, rounding=ROUND_DOWN), basis)
                for dentist, basis in minutes.items()
            ]
        )
        for dentist, amount, _ in parts:
            totals[(row.clinic_id, dentist)]["operating_cost"] += amount
        remaining = row.amount - sum((amount for _, amount, _ in parts), ZERO)
        proof.append({
            **base, "scope": row.scope, "evidence_ref": evidence_ref, "category": row.expense_category,
            "amount": amount_data(row.amount), "unallocated_amount": amount_data(remaining),
            "allocations": [{
                "dentist_id": str(dentist), "amount": amount_data(amount),
                "basis_minutes": amount_data(basis) if basis is not None else None,
            } for dentist, amount, basis in parts],
        })
    return proof


def company_totals(dentists, expenses):
    result = {
        "revenue": sum((Decimal(row["revenue"]) for row in dentists), ZERO),
        "material_cost": sum((Decimal(row["material_cost"]) for row in dentists), ZERO),
        "operating_cost": sum((Decimal(row["amount"]) for row in expenses), ZERO),
    }
    result["net_profit"] = result["revenue"] - result["material_cost"] - result["operating_cost"]
    result["incentive_fund"] = (max(result["net_profit"], ZERO) * Decimal("0.10")).quantize(CENT, rounding=ROUND_HALF_UP)
    return {key: amount_data(value) for key, value in result.items()}


def initial_calculation(period):
    totals = defaultdict(lambda: {"revenue": ZERO, "material_cost": ZERO, "operating_cost": ZERO, "basis_minutes": ZERO})
    missing = []
    visits = visit_sources(period, totals, missing)
    expenses = expense_sources(period, totals, missing)
    dentists = []
    for (clinic, dentist), fields in sorted(totals.items()):
        fields["material_cost"] = fields["material_cost"].quantize(CENT, rounding=ROUND_HALF_UP)
        fields["net_profit"] = fields["revenue"] - fields["material_cost"] - fields["operating_cost"]
        dentists.append({
            "clinic_id": str(clinic), "dentist_id": str(dentist), **{key: amount_data(value) for key, value in fields.items()},
        })
    return {"visits": visits, "expenses": expenses, "dentists": dentists, "company": company_totals(dentists, expenses),
            "missing": missing, "source": None}


def require_closure(result):
    for expense in result["expenses"]:
        allocated = sum((Decimal(part["amount"]) for part in expense["allocations"]), ZERO)
        if allocated + Decimal(expense["unallocated_amount"]) != Decimal(expense["amount"]):
            raise ApiProblem(409, "EVIDENCE_REQUIRED", "费用分摊与未分配金额未闭合。")
    if sum((Decimal(row["net_profit"]) for row in result["dentists"]), ZERO) - unallocated_amount(result) != Decimal(
        result["company"]["net_profit"],
    ):
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "牙医与公司的季度金额未闭合。")


def unallocated_amount(result):
    return sum((Decimal(row["unallocated_amount"]) for row in result["expenses"]), ZERO)


def save_results(revision, result):
    key = {"period_id": revision.period_id, "revision_no": revision.revision_no}
    DentistPerformance.objects.filter(**key).delete()
    DentistPerformance.objects.bulk_create([
        DentistPerformance(
            **key, clinic_id=row["clinic_id"], dentist_id=row["dentist_id"],
            **{field: Decimal(row[field]) for field in MONEY},
        ) for row in result["dentists"]
    ])
    CompanyPerformance.objects.update_or_create(
        **key, defaults={**{field: Decimal(value) for field, value in result["company"].items()}, "calculated_at": timezone.now()},
    )
    if revision.revision_no == 1:
        ExpenseAllocation.objects.filter(expense__period_id=revision.period_id).delete()
        ExpenseAllocation.objects.bulk_create([
            ExpenseAllocation(
                expense_id=expense["expense_id"], dentist_id=part["dentist_id"], allocated_amount=Decimal(part["amount"]),
                basis_minutes=Decimal(part["basis_minutes"]) if part["basis_minutes"] is not None else None,
            ) for expense in result["expenses"] for part in expense["allocations"]
        ])
