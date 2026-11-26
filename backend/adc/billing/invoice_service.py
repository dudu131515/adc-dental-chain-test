from decimal import Decimal
import re
from uuid import uuid4

from django.db import connection, transaction
from django.db.models import Sum
from django.utils import timezone

from adc.billing.models import Invoice, InvoiceAdjustment, InvoiceLine, InvoicePayment
from adc.booking.models import DepositRefund
from adc.clinical.models import TreatmentItem, Visit
from adc.clinical.treatment_evidence import name_snapshots
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog
from adc.payments.simulator import PaymentOperation, SimulatedGateway, dispatch_after_commit
from adc.reporting.period_locks import lock_period_for_end


ZERO = Decimal("0.00")


def amount_data(amount):
    return format(amount, ".2f")


def balance(invoice):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT accrued_amount, received_amount, refunded_amount, outstanding_amount, refund_due
            FROM invoice_reporting_fact WHERE invoice_id = %s
            """,
            [invoice.pk],
        )
        accrued, received, refunded, outstanding, refund_due = cursor.fetchone()
    pending = {
        row["payment_kind"]: row["total"] for row in InvoicePayment.objects.filter(invoice=invoice, status="PENDING")
        .values("payment_kind").annotate(total=Sum("amount"))
    }
    return {
        "accrued": accrued, "received": received, "refunded": refunded, "net_received": received - refunded,
        "outstanding": outstanding, "refund_due": refund_due,
        "pending_collection": pending.get("PAYMENT", ZERO), "pending_refund": pending.get("REFUND", ZERO),
    }


def apply_status(invoice):
    totals = balance(invoice)
    if not totals["outstanding"]:
        new_status = "SETTLED"
    elif totals["net_received"] > 0:
        new_status = "PART_PAID"
    else:
        new_status = "ISSUED"
    if invoice.status != new_status:
        invoice.status = new_status
        invoice.save(update_fields=("status",))


def issue_invoice(principal, first, operation):
    principal.require("FRONT_DESK", first.appointment.claim.clinic_id)
    if first.ended_at is None or first.status not in {"COMPLETED", "TERMINATED"}:
        raise ApiProblem(409, "INVALID_TRANSITION", "就诊尚未结束，暂不能开单。")
    with transaction.atomic():
        lock_period_for_end(first.ended_at)
        visit = Visit.objects.select_for_update().get(pk=first.pk)
        previous = operation.result_id({})
        if previous:
            return Invoice.objects.get(pk=previous), False
        original = Invoice.objects.filter(visit=visit).first()
        if original:
            operation.record_result(original.pk, {})
            return original, False
        items = list(TreatmentItem.objects.filter(visit=visit).order_by("pk"))
        snapshots = name_snapshots(items)
        if (visit.status == "COMPLETED" and not items) or any(not snapshots.get(item.pk) for item in items):
            raise ApiProblem(409, "EVIDENCE_REQUIRED", "缺少实际治疗计价快照，请由负责牙医核对。")
        original_total = sum((item.amount for item in items), ZERO)
        if original_total > Decimal("999999999999.99"):
            raise ApiProblem(409, "EVIDENCE_REQUIRED", "主单原始金额超出计费精度。")
        invoice = Invoice.objects.create(
            invoice_no="INV-" + uuid4().hex.upper(), visit=visit, original_total=original_total,
            status="ISSUED" if original_total else "SETTLED",
        )
        InvoiceLine.objects.bulk_create([
            InvoiceLine(
                invoice=invoice, treatment_item=item, treatment_name_snapshot=snapshots[item.pk],
                unit_name_snapshot=item.unit_name_snapshot, units=item.units,
                unit_price=item.unit_price_snapshot, subtotal=item.amount,
            )
            for item in items
        ])
        fields = {"visit_id": str(visit.pk), "original_total": amount_data(original_total), "line_count": len(items)}
        record_event(
            account_id=principal.account_id, action="INVOICE_ISSUED", target_type="invoice",
            target_id=invoice.pk, visible_fields=fields.keys(), after=fields,
        )
        operation.record_result(invoice.pk, {})
        return invoice, True


def payment_operation(payment):
    return PaymentOperation("invoice_payment", payment.pk, payment.amount, payment.idempotency_key)


def create_payment(principal, first, amount, operation):
    with transaction.atomic():
        invoice = Invoice.objects.select_for_update().get(pk=first.pk)
        existing = operation.result_id({"amount": amount})
        if existing is not None:
            return InvoicePayment.objects.get(pk=existing), False
        totals = balance(invoice)
        if amount > totals["outstanding"] - totals["pending_collection"]:
            raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "收款额超过主单当前可收的欠款。")
        payment = InvoicePayment.objects.create(
            invoice=invoice, payment_kind="PAYMENT", amount=amount, status="PENDING",
            idempotency_key="invoice-payment:" + operation.scope_digest,
        )
        operation.record_result(payment.pk, {"amount": amount})
        dispatch_after_commit(payment_operation(payment), receive_payment)
        fields = {"invoice_id": str(invoice.pk), "amount": amount_data(amount)}
        record_event(
            account_id=principal.account_id, action="INVOICE_PAYMENT_RECORDED", target_type="invoice_payment",
            target_id=payment.pk, visible_fields=fields.keys(), after=fields,
        )
        return payment, True


def receive_payment(receipt):
    with transaction.atomic():
        preliminary = InvoicePayment.objects.get(pk=receipt.operation.id)
        invoice = Invoice.objects.select_for_update().get(pk=preliminary.invoice_id)
        payment = InvoicePayment.objects.select_for_update().get(pk=preliminary.pk)
        if payment.payment_kind != "PAYMENT" or not SimulatedGateway().matches(payment_operation(payment), receipt):
            raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "回执与原收款义务不匹配。")
        if payment.status == "SUCCEEDED" or payment.status == receipt.outcome:
            return
        payment.status = receipt.outcome
        payment.paid_at = timezone.now() if receipt.outcome == "SUCCEEDED" else None
        payment.save(update_fields=("status", "paid_at"))
        apply_status(invoice)
        details = {"invoice_id": str(invoice.pk), "receipt_ref": receipt.reference, "status": payment.status}
        record_event(
            account_id=None, action="INVOICE_PAYMENT_RECEIPT", target_type="invoice_payment",
            target_id=payment.pk, visible_fields=details.keys(), after=details,
        )


def payment_data(payment):
    return {
        "payment_id": str(payment.pk), "invoice_id": str(payment.invoice_id), "kind": payment.payment_kind,
        "status": payment.status, "amount": amount_data(payment.amount),
        "paid_at": payment.paid_at.isoformat() if payment.paid_at else None,
        "source_payment_id": str(payment.source_payment_id) if payment.source_payment_id else None,
        "adjustment_id": str(payment.adjustment_id) if payment.adjustment_id else None,
    }


def needs_reconciliation(refund_id):
    decision = AuditLog.objects.filter(
        action__in=("INVOICE_REFUND_CONFLICT", "INVOICE_REFUND_RECONCILED"),
        target_type="invoice_payment", target_id=refund_id,
    ).order_by("-pk").first()
    return bool(decision and decision.action == "INVOICE_REFUND_CONFLICT")


def invoice_data(invoice, actor):
    visit = invoice.visit
    booking = visit.appointment
    totals = balance(invoice)
    clerk = actor.allows("FRONT_DESK", booking.claim.clinic_id)
    lines = InvoiceLine.objects.filter(invoice=invoice).order_by("pk")
    adjustments = InvoiceAdjustment.objects.filter(invoice=invoice).order_by("pk")
    result = {
        "invoice_id": str(invoice.pk), "invoice_no": invoice.invoice_no,
        "visit_id": str(visit.pk), "appointment_no": booking.appointment_no, "status": invoice.status,
        "clinic_id": str(booking.claim.clinic_id), "clinic_name": booking.claim.clinic.clinic_name,
        "ended_at": visit.ended_at.isoformat() if visit.ended_at else None,
        "original_total": amount_data(invoice.original_total), "issued_at": invoice.issued_at.isoformat(),
        "lines": [
            {
                "line_id": str(line.pk), "treatment_name": line.treatment_name_snapshot,
                "unit": line.unit_name_snapshot, "units": format(line.units, ".3f"),
                "unit_price": amount_data(line.unit_price), "subtotal": amount_data(line.subtotal),
            } for line in lines
        ],
        "adjustments": [
            {"adjustment_id": str(row.pk), "correction_id": str(row.correction_id), "signed_amount": amount_data(row.signed_amount)}
            for row in adjustments
        ],
        "accrued": amount_data(totals["accrued"]),
        "allowed_actions": [],
    }
    if clerk:
        refund = DepositRefund.objects.filter(deposit_id=booking.deposit_id).first()
        result.update({
            **{name: amount_data(amount) for name, amount in totals.items()},
            "patient_display": {
                "name": booking.claim.patient.full_name,
                "phone_tail": (
                    lambda digits: digits[-4:] if len(digits) > 4 else None
                )(re.sub(r"[^0-9]", "", booking.claim.patient.phone or "")),
            },
            "deposit": {"amount": amount_data(booking.deposit.amount), "status": booking.deposit.status},
            "deposit_refund": {"amount": amount_data(refund.refund_amount), "status": refund.status} if refund else None,
            "payments": [
                {**payment_data(row), "reconciliation_required": row.payment_kind == "REFUND" and needs_reconciliation(row.pk)}
                for row in InvoicePayment.objects.filter(invoice=invoice).order_by("pk")
            ],
        })
        if totals["outstanding"] > totals["pending_collection"]:
            result["allowed_actions"].append("collect")
        if totals["refund_due"] > totals["pending_refund"]:
            result["allowed_actions"].append("refund")
    if actor.allows("DENTIST", booking.claim.clinic_id) and actor.employee_id == visit.main_dentist_id:
        result["allowed_actions"].append("request_correction")
    return result
