from decimal import Decimal

from django.db import transaction
from django.db.models import Max
from django.shortcuts import get_object_or_404

from adc.billing.invoice_service import amount_data, apply_status, balance
from adc.billing.models import CorrectionApproval, Invoice, InvoiceAdjustment, TreatmentCorrection
from adc.clinical.models import Visit
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog
from adc.reporting.models.periods import PerformanceRevision
from adc.reporting.period_locks import lock_period_for_end


def evidence(principal, correction, action, **fields):
    return record_event(
        account_id=principal.account_id, action=action, target_type="treatment_correction",
        target_id=correction.pk, visible_fields=fields.keys(), after=fields,
    )


def new_correction(principal, original, fields, operation):
    with transaction.atomic():
        visit = Visit.objects.select_for_update().get(pk=original.pk)
        prior = operation.result_id(fields)
        if prior is not None:
            return TreatmentCorrection.objects.get(pk=prior), False
        invoice = get_object_or_404(Invoice, pk=fields["invoice_id"], visit=visit)
        proposed = fields["proposed_changes"]
        recorded = TreatmentCorrection.objects.create(
            visit=visit, requested_by_id=principal.employee_id, status="PENDING", reason=fields["reason"],
            proposed_changes={"summary": proposed["summary"], "signed_amount": amount_data(proposed["signed_amount"])},
        )
        evidence(principal, recorded, "CORRECTION_REQUESTED", invoice_id=str(invoice.pk), status="PENDING")
        operation.record_result(recorded.pk, fields)
        return recorded, True


def review_correction(principal, first, fields, operation):
    with transaction.atomic():
        current = TreatmentCorrection.objects.select_for_update().get(pk=first.pk)
        if operation.result_id(fields) is not None:
            return current
        if current.status != "PENDING":
            raise ApiProblem(409, "INVALID_TRANSITION", "该更正已有审批结果。")
        decision = fields["decision"]
        correction_value = fields.get("approved_signed_amount", Decimal(current.proposed_changes["signed_amount"]))
        invoice = Invoice.objects.get(visit_id=current.visit_id)
        if decision == "APPROVED" and balance(invoice)["accrued"] + correction_value < 0:
            raise ApiProblem(409, "VALIDATION_ERROR", "获批差额不能使主单应计低于零。")
        approved = CorrectionApproval.objects.create(
            correction=current, reviewer_id=principal.employee_id, decision=decision, reason=fields["reason"],
        )
        current.status = decision
        current.save(update_fields=("status",))
        evidence(
            principal, current, "CORRECTION_DECIDED", decision=decision, invoice_id=str(invoice.pk),
            approval_id=str(approved.pk), amount=amount_data(correction_value) if decision == "APPROVED" else None,
        )
        operation.record_result(current.pk, fields)
        return current


def create_revision(period, adjustment):
    if period.status != "CONFIRMED":
        return None
    latest = PerformanceRevision.objects.filter(period=period).aggregate(last=Max("revision_no"))["last"]
    if not latest:
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "已确认季度缺少冻结原版，先核对季度依据。")
    revision, _ = PerformanceRevision.objects.get_or_create(
        source_adjustment=adjustment, defaults={"period": period, "revision_no": latest + 1},
    )
    return revision


def approval_evidence(correction, invoice_id):
    return AuditLog.objects.filter(
        action="CORRECTION_DECIDED", target_type="treatment_correction", target_id=correction.pk,
        after_value__decision="APPROVED", after_value__invoice_id=str(invoice_id),
    ).order_by("-pk").first()


def apply_correction(principal, first, fields, operation):
    visit = first.visit
    with transaction.atomic():
        period = lock_period_for_end(visit.ended_at)
        invoice = get_object_or_404(Invoice.objects.select_for_update(), pk=fields["invoice_id"], visit=visit)
        current = TreatmentCorrection.objects.select_for_update().get(pk=first.pk)
        previous = operation.result_id(fields)
        if previous is not None:
            return InvoiceAdjustment.objects.get(pk=previous)
        existing = InvoiceAdjustment.objects.filter(correction=current, invoice=invoice).first()
        if existing:
            operation.record_result(existing.pk, fields)
            return existing
        if current.status != "APPROVED":
            raise ApiProblem(409, "INVALID_TRANSITION", "仅已获批的同次更正可入账。")
        approval = approval_evidence(current, invoice.pk)
        if not approval:
            raise ApiProblem(409, "EVIDENCE_REQUIRED", "无法核对获批的原主单和差额。")
        amount = Decimal(approval.after_value["amount"])
        if balance(invoice)["accrued"] + amount < 0:
            raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "应计已变，请重新核对获批差额。")
        adjustment = InvoiceAdjustment.objects.create(invoice=invoice, correction=current, signed_amount=amount)
        current.status = "APPLIED"
        current.save(update_fields=("status",))
        revision = create_revision(period, adjustment)
        apply_status(invoice)
        evidence(
            principal, current, "CORRECTION_APPLIED", invoice_id=str(invoice.pk), adjustment_id=str(adjustment.pk),
            signed_amount=amount_data(amount), period_id=str(period.pk), revision_no=revision.revision_no if revision else None,
        )
        operation.record_result(adjustment.pk, fields)
        return adjustment
