from copy import deepcopy
from decimal import Decimal

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from adc.billing.invoice_service import ZERO, amount_data
from adc.billing.models import CorrectionApproval
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog
from adc.reporting.models import PerformancePeriod, PerformanceRevision
from adc.reporting.permissions import WORK_ROLES, includes_company
from adc.reporting.quarter_calculation import (
    company_totals, initial_calculation, require_closure, save_results, unallocated_amount,
)


def event_for(revision, action):
    return AuditLog.objects.filter(
        target_type="performance_revision", target_id=revision.pk, action=action,
    ).order_by("-pk").first()


def record(principal, revision, action, fields):
    return record_event(
        account_id=principal.account_id, action=action, target_type="performance_revision",
        target_id=revision.pk, visible_fields=fields.keys(), after=fields,
    )


def current_period(pk):
    return get_object_or_404(PerformancePeriod.objects.select_for_update(), pk=pk)


def latest_confirmed(period_id):
    return PerformanceRevision.objects.filter(period_id=period_id, confirmed_at__isnull=False).order_by("-revision_no").first()


def assert_order(revision):
    latest = latest_confirmed(revision.period_id)
    required = latest.revision_no + 1 if latest else 1
    if revision.revision_no != required:
        raise ApiProblem(
            409, "INVALID_TRANSITION", "必须先确认前一个季度版本。",
            details={"next_revision_no": required},
        )


def revision_inputs(revision):
    if revision.revision_no == 1:
        return initial_calculation(revision.period)
    previous = PerformanceRevision.objects.get(period_id=revision.period_id, revision_no=revision.revision_no - 1)
    proof = event_for(previous, "PERFORMANCE_CALCULATED")
    if not previous.confirmed_at or not proof:
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "前一确认版缺少冻结的计算依据。")
    frozen = deepcopy(proof.after_value["result"])
    source = revision.source_adjustment
    visit = source.invoice.visit
    approval = CorrectionApproval.objects.filter(correction_id=source.correction_id, decision="APPROVED").first()
    visit_row = next((row for row in frozen["visits"] if row["visit_id"] == str(visit.pk)), None)
    if not approval or not visit_row or str(source.pk) in visit_row["adjustment_ids"]:
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "差额缺少唯一的审批或原季度就诊依据。")
    contribution = next(
        row for row in frozen["dentists"]
        if row["clinic_id"] == visit_row["clinic_id"] and row["dentist_id"] == visit_row["dentist_id"]
    )
    signed_amount = source.signed_amount
    visit_row["adjustment_ids"].append(str(source.pk))
    visit_row["accrued"] = amount_data(Decimal(visit_row["accrued"]) + signed_amount)
    contribution["revenue"] = amount_data(Decimal(contribution["revenue"]) + signed_amount)
    contribution["net_profit"] = amount_data(Decimal(contribution["net_profit"]) + signed_amount)
    frozen["company"] = company_totals(frozen["dentists"], frozen["expenses"])
    frozen["source"] = {
        "adjustment_id": str(source.pk), "invoice_id": str(source.invoice_id), "visit_id": str(visit.pk),
        "clinic_id": visit_row["clinic_id"], "approval_id": str(approval.pk), "approver_id": str(approval.reviewer_id),
        "approved_at": approval.decided_at.isoformat(), "signed_amount": amount_data(signed_amount),
        "previous_revision_no": previous.revision_no,
    }
    return frozen


def latest_decision(revision, calculation):
    review = event_for(revision, "PERFORMANCE_REVIEWED")
    if review and calculation and review.after_value["calculation_id"] == str(calculation.pk):
        return review.after_value
    return None


def revisions_for(period_id, workspace):
    rows = PerformanceRevision.objects.filter(period_id=period_id).order_by("revision_no")
    return rows if workspace else rows.filter(confirmed_at__isnull=False)


def scoped_result(result, scope):
    if scope is None:
        return result
    return {key: [row for row in result[key] if int(row["clinic_id"]) in scope]
            for key in ("visits", "expenses", "dentists", "missing")}


def projection(revision, principal):
    calculation = event_for(revision, "PERFORMANCE_CALCULATED")
    decision = latest_decision(revision, calculation)
    result = calculation.after_value["result"] if calculation else None
    scope = principal.clinic_scope("HQ_OPERATIONS_QUERY", *WORK_ROLES) if revision.confirmed_at else principal.clinic_scope(*WORK_ROLES)
    full = includes_company(scope)
    status = "PENDING"
    if calculation:
        status = "NEEDS_DATA" if result["missing"] else "REVIEW"
    if decision and decision["decision"] == "REJECTED":
        status = "RETURNED"
    if revision.confirmed_at:
        status = "CONFIRMED"
    data = {
        "period_id": str(revision.period_id), "revision_no": revision.revision_no, "status": status,
        "confirmed_by": str(revision.confirmed_by_id) if revision.confirmed_by_id else None,
        "confirmed_at": revision.confirmed_at.isoformat() if revision.confirmed_at else None,
        "calculated_at": calculation.occurred_at.isoformat() if calculation else None,
    }
    if result:
        visible = scoped_result(result, scope)
        data.update(visible)
        data["unallocated_amount"] = amount_data(unallocated_amount(visible))
        source = result["source"]
        if source and (scope is None or int(source["clinic_id"]) in scope):
            data["source"] = source
        if full:
            original = revision if revision.revision_no == 1 else PerformanceRevision.objects.get(
                period_id=revision.period_id, revision_no=1,
            )
            original_event = event_for(original, "PERFORMANCE_CALCULATED")
            original_values = original_event.after_value["result"]["company"]
            data.update({
                "company": result["company"], "original_company": original_values, "review": decision,
                "company_delta": {
                    key: amount_data(Decimal(value) - Decimal(original_values[key]))
                    for key, value in result["company"].items()
                },
            })
    if revision.confirmed_at is None and full:
        data["allowed_actions"] = (
            (["review"] if status == "REVIEW" and decision is None and principal.allows(WORK_ROLES[1]) else [])
            + (["confirm"] if status == "REVIEW" and decision and decision["decision"] == "APPROVED"
               and principal.allows(WORK_ROLES[2]) else [])
        )
    return data


@transaction.atomic
def calculate(principal, period_id, operation):
    period = current_period(period_id)
    prior = operation.result_id({})
    if prior:
        return PerformanceRevision.objects.get(pk=prior)
    if period.status == "CONFIRMED":
        revision = revisions_for(period.pk, True).filter(confirmed_at__isnull=True).first()
        if revision is None:
            raise ApiProblem(409, "INVALID_TRANSITION", "该季度没有等待核算的获批差额。")
    else:
        revision, _ = PerformanceRevision.objects.get_or_create(period=period, revision_no=1)
    assert_order(revision)
    result = revision_inputs(revision)
    if not result["missing"]:
        require_closure(result)
        save_results(revision, result)
    record(principal, revision, "PERFORMANCE_CALCULATED", {"result": result})
    if revision.revision_no == 1:
        period.status = "NEEDS_DATA" if result["missing"] else "REVIEW"
        period.save(update_fields=("status",))
    operation.record_result(revision.pk, {})
    return revision


def actionable_revision(period_id, revision_no):
    period = current_period(period_id)
    return get_object_or_404(PerformanceRevision.objects.select_related("period"), period=period, revision_no=revision_no)


def verify_current_calculation(revision):
    calculation = event_for(revision, "PERFORMANCE_CALCULATED")
    if not calculation or calculation.after_value["result"]["missing"]:
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "请完成试算并补齐缺项后再办理。")
    proof = calculation.after_value["result"]
    if proof != revision_inputs(revision):
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "季度来源依据已变化，请重新试算并复核。")
    require_closure(proof)
    return calculation


@transaction.atomic
def review(principal, period_id, revision_no, fields, operation):
    revision = actionable_revision(period_id, revision_no)
    if operation.result_id(fields):
        return revision
    if revision.confirmed_at:
        raise ApiProblem(409, "INVALID_TRANSITION", "已确认版本已冻结。")
    assert_order(revision)
    calculation = verify_current_calculation(revision)
    if latest_decision(revision, calculation):
        raise ApiProblem(409, "INVALID_TRANSITION", "该次试算已有复核结果。")
    record(principal, revision, "PERFORMANCE_REVIEWED", {
        **fields, "reviewer_id": str(principal.employee_id), "calculation_id": str(calculation.pk),
    })
    if fields["decision"] == "REJECTED" and revision_no == 1:
        revision.period.status = "OPEN"
        revision.period.save(update_fields=("status",))
    operation.record_result(revision.pk, fields)
    return revision


@transaction.atomic
def confirm(principal, period_id, revision_no, operation):
    revision = actionable_revision(period_id, revision_no)
    if operation.result_id({}) or revision.confirmed_at:
        return revision
    assert_order(revision)
    calculation = verify_current_calculation(revision)
    decision = latest_decision(revision, calculation)
    if not decision or decision["decision"] != "APPROVED":
        raise ApiProblem(409, "INVALID_TRANSITION", "当前试算须先通过授权复核。")
    revision.confirmed_by_id = principal.employee_id
    revision.confirmed_at = timezone.now()
    revision.save(update_fields=("confirmed_by", "confirmed_at"))
    if revision_no == 1:
        revision.period.status = "CONFIRMED"
        revision.period.save(update_fields=("status",))
    record(principal, revision, "PERFORMANCE_CONFIRMED", {
        "calculation_id": str(calculation.pk), "confirmed_at": revision.confirmed_at.isoformat(),
        "confirmed_by": str(principal.employee_id), "revision_no": revision_no,
    })
    operation.record_result(revision.pk, {})
    return revision
