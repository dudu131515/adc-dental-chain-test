from django.db import transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone

from adc.billing.invoice_service import ZERO, amount_data, apply_status, balance, needs_reconciliation
from adc.billing.models import Invoice, InvoiceAdjustment, InvoicePayment
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.payments.simulator import PaymentOperation, SimulatedGateway, dispatch_after_commit


def refund_operation(refund):
    return PaymentOperation("invoice_refund", refund.pk, refund.amount, refund.idempotency_key, refund.source_payment_id)


def original_remaining(source, omit=None):
    active = source.refunds.filter(status__in=("PENDING", "SUCCEEDED"))
    if omit is not None:
        active = active.exclude(pk=omit)
    return source.amount - (active.aggregate(total=Sum("amount"))["total"] or ZERO)


def require_limit(invoice, source, amount, omit=None):
    totals = balance(invoice)
    if (
        source.invoice_id != invoice.pk or source.payment_kind != "PAYMENT" or source.status != "SUCCEEDED"
        or amount > original_remaining(source, omit) or amount > totals["refund_due"] - totals["pending_refund"]
    ):
        raise ApiProblem(409, "REFUND_LIMIT_EXCEEDED", "退款须关联同一主单的合法原收款，并符合剩余应退及原付款限额。")


def evidence(refund, action, *, actor=None, **details):
    payload = {
        "invoice_id": str(refund.invoice_id), "source_payment_id": str(refund.source_payment_id),
        "amount": amount_data(refund.amount), **details,
    }
    return record_event(
        account_id=actor, action=action, target_type="invoice_payment", target_id=refund.pk,
        visible_fields=payload.keys(), after=payload,
    )


def request_refund(actor, invoice_id, fields, operation):
    with transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(pk=invoice_id)
        existing = operation.result_id(fields)
        if existing is not None:
            return InvoicePayment.objects.get(pk=existing), False
        source = get_object_or_404(InvoicePayment.objects.select_for_update(), pk=fields["source_payment_id"], invoice=invoice)
        amount = fields["amount"]
        require_limit(invoice, source, amount)
        adjustment = None
        if fields.get("adjustment_id") is not None:
            adjustment = get_object_or_404(InvoiceAdjustment, pk=fields["adjustment_id"], invoice=invoice)
            if adjustment.signed_amount >= 0:
                raise ApiProblem(409, "REFUND_LIMIT_EXCEEDED", "退款关联的获批差额须为减额。")
        refund = InvoicePayment.objects.create(
            invoice=invoice, payment_kind="REFUND", source_payment=source, adjustment=adjustment,
            amount=amount, status="PENDING", idempotency_key="invoice-refund:" + operation.scope_digest,
        )
        operation.record_result(refund.pk, fields)
        evidence(
            refund, "INVOICE_REFUND_RECORDED", actor=actor.account_id,
            adjustment_id=str(adjustment.pk) if adjustment else None, status="PENDING",
        )
        dispatch_after_commit(refund_operation(refund), receive_refund)
        return refund, True


def retry_refund(actor, invoice_id, refund_id):
    with transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(pk=invoice_id)
        first = get_object_or_404(InvoicePayment, pk=refund_id, invoice=invoice, payment_kind="REFUND")
        source = InvoicePayment.objects.select_for_update().get(pk=first.source_payment_id)
        refund = InvoicePayment.objects.select_for_update().get(pk=refund_id)
        if needs_reconciliation(refund.pk):
            raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "该退款有待核对的回执，暂停再次办理。")
        if refund.status == "FAILED":
            require_limit(invoice, source, refund.amount, omit=refund.pk)
            refund.status = "PENDING"
            refund.save(update_fields=("status",))
            evidence(refund, "INVOICE_REFUND_RETRIED", actor=actor.account_id, status="PENDING")
            dispatch_after_commit(refund_operation(refund), receive_refund)
        return refund


def receive_refund(receipt):
    conflict = False
    with transaction.atomic():
        first = InvoicePayment.objects.get(pk=receipt.operation.id, payment_kind="REFUND")
        invoice = Invoice.objects.select_for_update().get(pk=first.invoice_id)
        source = InvoicePayment.objects.select_for_update().get(pk=first.source_payment_id)
        refund = InvoicePayment.objects.select_for_update().get(pk=first.pk)
        verified = (
            source.status == "SUCCEEDED" and source.payment_kind == "PAYMENT" and source.invoice_id == invoice.pk
            and SimulatedGateway().matches(refund_operation(refund), receipt)
        )
        over_origin = (
            refund.status != "SUCCEEDED" and receipt.outcome == "SUCCEEDED"
            and refund.amount > original_remaining(source, omit=refund.pk)
        )
        if not verified or over_origin:
            evidence(
                refund, "INVOICE_REFUND_CONFLICT", receipt_ref=receipt.reference,
                reason="ORIGINAL_LIMIT" if over_origin else "RECEIPT_MISMATCH",
            )
            conflict = True
        else:
            if needs_reconciliation(refund.pk) and receipt.outcome == "SUCCEEDED":
                evidence(refund, "INVOICE_REFUND_RECONCILED", receipt_ref=receipt.reference)
            if refund.status != "SUCCEEDED" and refund.status != receipt.outcome:
                refund.status = receipt.outcome
                refund.paid_at = timezone.now() if receipt.outcome == "SUCCEEDED" else None
                refund.save(update_fields=("status", "paid_at"))
                apply_status(invoice)
                evidence(refund, "INVOICE_REFUND_RECEIPT", receipt_ref=receipt.reference, status=refund.status)
    if conflict:
        raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "回执与原退款义务或原收款不一致。")
