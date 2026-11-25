from uuid import uuid4

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from adc.booking.hold_service import validate_candidate
from adc.booking.models import Appointment, AppointmentRequestedTreatment, DepositPayment, DepositRefund, SlotClaim
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Clinic, Employee
from adc.payments.simulator import PaymentOperation, SimulatedGateway, dispatch_after_commit
from adc.scheduling.models import Shift


def deposit_operation(payment):
    return PaymentOperation("deposit", payment.pk, payment.amount, payment.payment_token)


def refund_operation(refund):
    return PaymentOperation("deposit_refund", refund.pk, refund.refund_amount, refund.idempotency_key, refund.deposit_id)


def funds_evidence(action, target_type, target_id, *, account_id=None, **evidence):
    return record_event(
        account_id=account_id, action=action, target_type=target_type, target_id=target_id,
        visible_fields=evidence.keys(), after=evidence,
    )


def lock_deposit_claim(payment_id):
    first = DepositPayment.objects.select_related("claim").get(pk=payment_id)
    Employee.objects.select_for_update().get(pk=first.claim.dentist_id)
    Clinic.objects.select_for_update().get(pk=first.claim.clinic_id)
    shift = Shift.objects.select_for_update().get(pk=first.claim.shift_id)
    claim = SlotClaim.objects.select_for_update(of=("self",)).select_related("requested_treatment_type").get(pk=first.claim_id)
    payment = DepositPayment.objects.select_for_update().get(pk=payment_id)
    return shift, claim, payment


def request_simulation(payment_id, account_id):
    uneventful_expiry = False
    with transaction.atomic():
        _, claim, payment = lock_deposit_claim(payment_id)
        if payment.status != "PENDING":
            return payment
        now = timezone.now()
        if payment.payment_token is None:
            if claim.status != "HOLD" or claim.expires_at <= now:
                if claim.status == "HOLD":
                    claim.status = "EXPIRED"
                    claim.save(update_fields=("status",))
                uneventful_expiry = True
            else:
                payment.payment_token = "deposit:" + str(payment.pk)
                payment.save(update_fields=("payment_token",))
                funds_evidence(
                    "DEPOSIT_SIMULATION_REQUESTED", "deposit_payment", payment.pk,
                    account_id=account_id, claim_id=str(claim.pk), amount=format(payment.amount, ".2f"),
                )
        if not uneventful_expiry:
            dispatch_after_commit(deposit_operation(payment), receive_deposit)
    if uneventful_expiry:
        raise ApiProblem(409, "HOLD_EXPIRED", "占位已失效，请重新选择时段。")
    return payment


def transfer_hold_context(claim, payment):
    event = AuditLog.objects.filter(
        action="HOLD_CONTEXT", target_type="slot_claim", target_id=claim.pk,
    ).order_by("-pk").first()
    context = event.after_value if event else {}
    record = Appointment.objects.create(
        appointment_no="ADC-" + uuid4().hex.upper(), claim=claim, deposit=payment, status="CONFIRMED",
        special_requirement=context.get("special_requirement"),
    )
    for project in context.get("other_treatment_ids", []):
        AppointmentRequestedTreatment.objects.create(appointment=record, treatment_type_id=project)
    return record


def receive_deposit(receipt):
    with transaction.atomic():
        shift, claim, payment = lock_deposit_claim(receipt.operation.id)
        if not payment.payment_token or not SimulatedGateway().matches(deposit_operation(payment), receipt):
            raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "模拟回执与原付款义务不匹配。")
        if payment.status == "PAID" or (payment.status == "FAILED" and receipt.outcome == "FAILED"):
            return
        now = timezone.now()
        if receipt.outcome == "FAILED":
            payment.status = "FAILED"
            payment.save(update_fields=("status",))
            if claim.status == "HOLD":
                claim.status = "EXPIRED" if claim.expires_at <= now else "RELEASED"
                claim.save(update_fields=("status",))
        else:
            payment.status, payment.paid_at = "PAID", now
            payment.save(update_fields=("status", "paid_at"))
            finish_successful_deposit(shift, claim, payment, now)
        funds_evidence(
            "DEPOSIT_RECEIPT", "deposit_payment", payment.pk,
            receipt_ref=receipt.reference, status=payment.status, claim_id=str(claim.pk),
            amount=format(payment.amount, ".2f"),
        )


def finish_successful_deposit(shift, claim, payment, now):
    timely = claim.status == "HOLD" and claim.expires_at > now
    if timely:
        try:
            validate_candidate(
                shift, claim.requested_treatment_type, claim.start_at, claim.end_at, now,
                exclude_claim_id=claim.pk, chair_kind=claim.required_chair_kind,
            )
        except ApiProblem as failure:
            if failure.code != "RESOURCE_CONFLICT":
                raise
            timely = False
    if timely:
        claim.status = "CONFIRMED"
        claim.save(update_fields=("status",))
        transfer_hold_context(claim, payment)
        return
    if claim.status == "HOLD":
        claim.status = "EXPIRED" if claim.expires_at <= now else "RELEASED"
        claim.save(update_fields=("status",))
    create_deposit_refund(payment, payment.amount, "UNCONFIRMED_APPOINTMENT")


def create_deposit_refund(payment, amount, reason, *, account_id=None):
    if payment.status != "PAID" or not 0 <= amount <= payment.amount:
        raise ApiProblem(409, "REFUND_LIMIT_EXCEEDED", "退款金额须以成功原款为限。")
    refund, created = DepositRefund.objects.get_or_create(
        idempotency_key="deposit-refund:" + str(payment.pk),
        defaults={
            "deposit": payment, "refund_amount": amount, "reason": reason,
            "status": "PENDING" if amount else "RETAINED",
        },
    )
    if not created and (refund.refund_amount != amount or refund.reason != reason):
        raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "同一原付款已有不同的退款处理结论。")
    if created:
        funds_evidence(
            "DEPOSIT_REFUND_RECORDED", "deposit_refund", refund.pk, account_id=account_id,
            deposit_id=str(payment.pk), amount=format(amount, ".2f"), reason=reason, status=refund.status,
        )
        if amount:
            dispatch_after_commit(refund_operation(refund), receive_refund)
    return refund


def receive_refund(receipt):
    with transaction.atomic():
        first = DepositRefund.objects.get(pk=receipt.operation.id)
        payment = DepositPayment.objects.select_for_update().get(pk=first.deposit_id)
        refund = DepositRefund.objects.select_for_update().get(pk=first.pk)
        if payment.status != "PAID" or not SimulatedGateway().matches(refund_operation(refund), receipt):
            raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "退金回执与原款及义务不匹配。")
        if refund.status in {"SUCCEEDED", "RETAINED"} or refund.status == receipt.outcome:
            return
        refund.status = receipt.outcome
        refund.completed_at = timezone.now() if receipt.outcome == "SUCCEEDED" else None
        refund.save(update_fields=("status", "completed_at"))
        funds_evidence(
            "DEPOSIT_REFUND_RECEIPT", "deposit_refund", refund.pk,
            deposit_id=str(payment.pk), receipt_ref=receipt.reference, status=refund.status,
        )


def retry_refund(refund_id, account_id):
    with transaction.atomic():
        first = get_object_or_404(DepositRefund, pk=refund_id)
        pay = DepositPayment.objects.select_for_update().get(pk=first.deposit_id)
        refund = DepositRefund.objects.select_for_update().get(pk=refund_id)
        if refund.status == "FAILED":
            if pay.status != "PAID" or not 0 < refund.refund_amount <= pay.amount:
                raise ApiProblem(409, "REFUND_LIMIT_EXCEEDED", "请先核对退款原付款。")
            refund.status = "PENDING"
            refund.save(update_fields=("status",))
            funds_evidence(
                "DEPOSIT_REFUND_RETRIED", "deposit_refund", refund.pk, account_id=account_id,
                deposit_id=str(pay.pk), amount=format(refund.refund_amount, ".2f"),
            )
            dispatch_after_commit(refund_operation(refund), receive_refund)
    return refund
