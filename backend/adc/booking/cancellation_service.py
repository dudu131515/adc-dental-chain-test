from datetime import timedelta
from decimal import Decimal

from django.db import connection, transaction
from django.utils.timezone import now as service_now

from adc.booking.deposit_service import create_deposit_refund
from adc.booking.models import AppointmentChange, DepositPayment
from adc.booking.reschedule_service import lock_appointment_context, require_coordinator
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog


def patient_refund_amount(original, start, now):
    advance = start - now
    if advance >= timedelta(hours=24):
        return original
    if advance >= timedelta(hours=2):
        return (original / 2).quantize(Decimal("0.01"))
    return Decimal("0.00")


def require_cancellation_actor(principal, appointment, cause):
    claim = appointment.claim
    if principal.channel == "patient":
        if claim.patient_id != principal.patient_id or cause != "PATIENT":
            raise ApiProblem(403, "PERMISSION_DENIED", "患者本人只能办理自己的患者原因取消。")
    elif cause == "PATIENT":
        principal.require("FRONT_DESK", claim.clinic_id)
    else:
        require_coordinator(principal, claim.clinic_id)


def cancellation_quote(principal, appointment, cause, *, now=None, reviewed=False):
    if not reviewed:
        require_cancellation_actor(principal, appointment, cause)
    if appointment.is_attended or appointment.status not in {"CONFIRMED", "CHECKED_IN"}:
        raise ApiProblem(409, "INVALID_TRANSITION", "当前履约状态不能取消。")
    now = now or service_now()
    if not reviewed and (
        appointment.status == "CHECKED_IN" or now >= appointment.claim.start_at
    ):
        raise ApiProblem(409, "CANCELLATION_REVIEW_REQUIRED", "请先由门店核实是否继续接诊和实际责任。")
    if appointment.deposit.status != "PAID":
        raise ApiProblem(409, "PAYMENT_RESULT_CONFLICT", "请先核对正式预约的原款状态。")
    if cause == "CLINIC":
        return appointment.deposit.amount
    return patient_refund_amount(appointment.deposit.amount, appointment.claim.start_at, now)


def require_coordination_evidence(appointment, fields):
    if fields.get("coordination_evidence"):
        return
    if AuditLog.objects.filter(
        action="APPOINTMENT_COORDINATION_INTENT", target_type="appointment", target_id=appointment.pk,
        after_value__claim_id=str(appointment.claim_id),
    ).exists():
        return
    raise ApiProblem(400, "EVIDENCE_REQUIRED", "请先记录同店替代评估及未达成可履约安排的依据。")


def state_evidence(principal, appointment, action, prior_status, **details):
    fields = {"claim_id": str(appointment.claim_id), "status": appointment.status, **details}
    return record_event(
        account_id=principal.account_id, action=action, target_type="appointment",
        target_id=appointment.pk, visible_fields=("status", *fields),
        before={"status": prior_status}, after=fields,
    )


def finish_cancellation(principal, appointment, claim, reason, amount, now, *, party=None):
    prior = appointment.status
    kind = "NO_SHOW" if party is None else "CANCEL"
    appointment.status = "NO_SHOW" if kind == "NO_SHOW" else "CANCELLED"
    appointment.save(update_fields=("status",))
    claim.status = "RELEASED"
    claim.save(update_fields=("status",))
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE chair_usage SET released_at = %s WHERE appointment_id = %s AND released_at IS NULL",
            [now, appointment.pk],
        )
    AppointmentChange.objects.create(
        appointment=appointment, change_type=kind, cancel_party=party,
        old_claim=claim, reason=reason, changed_by_id=principal.employee_id,
        changed_by_patient_id=principal.patient_id, changed_at=now,
    )
    deposit = DepositPayment.objects.select_for_update().get(pk=appointment.deposit_id)
    refund = create_deposit_refund(
        deposit, amount, "NO_SHOW" if party is None else party + "_CANCELLATION",
        account_id=principal.account_id,
    )
    state_evidence(
        principal, appointment, "APPOINTMENT_" + kind, prior,
        reason=reason, party=party, refund_id=str(refund.pk), refund_amount=format(amount, ".2f"),
    )
    return appointment


def operate(principal, first, fields, operation, *, mode):
    initial = first.claim
    cause = fields.get("cause", "PATIENT")
    if mode == "ordinary":
        require_cancellation_actor(principal, first, cause)
    elif mode == "no_show":
        principal.require("FRONT_DESK", initial.clinic_id)
    else:
        require_coordinator(principal, initial.clinic_id)

    with transaction.atomic():
        appointment, claim, shifts = lock_appointment_context(
            first, {initial.dentist_id}, {initial.clinic_id}, {initial.shift_id},
        )
        if operation.result_id(fields) is not None:
            return appointment
        if fields["expected_claim_id"] != claim.pk:
            raise ApiProblem(409, "STALE_APPOINTMENT", "预约时段已变，请先核对当前安排。")
        now = service_now()
        if mode == "no_show":
            available = shifts[claim.shift_id].status == "PUBLISHED" and not AuditLog.objects.filter(
                action="SHIFT_WITHDRAWAL_REQUESTED", target_type="shift", target_id=claim.shift_id,
                occurred_at__lte=claim.end_at,
            ).exists()
            if (
                appointment.status != "CONFIRMED" or appointment.is_attended or now < claim.end_at
                or not fields["patient_absent"] or not fields["clinic_able"] or not available
            ):
                raise ApiProblem(409, "NO_SHOW_NOT_ELIGIBLE", "尚不符合人工爽约核实条件。")
            saved = finish_cancellation(principal, appointment, claim, fields["reason"], Decimal("0.00"), now)
        elif mode == "review":
            if (
                appointment.status not in {"CONFIRMED", "CHECKED_IN"} or appointment.is_attended
                or (appointment.status == "CONFIRMED" and now < claim.start_at)
            ):
                raise ApiProblem(409, "INVALID_TRANSITION", "当前预约不适用到点或签到后的人工核实。")
            conclusion = fields["conclusion"]
            state_evidence(
                principal, appointment, "CANCELLATION_REVIEWED", appointment.status,
                conclusion=conclusion, reason=fields["reason"], coordination_evidence=fields.get("coordination_evidence"),
            )
            if conclusion == "CONTINUE":
                saved = appointment
            else:
                party = "PATIENT" if conclusion == "PATIENT_CANCEL" else "CLINIC"
                amount = cancellation_quote(principal, appointment, party, now=now, reviewed=True)
                if party == "CLINIC":
                    require_coordination_evidence(appointment, fields)
                saved = finish_cancellation(principal, appointment, claim, fields["reason"], amount, now, party=party)
        else:
            amount = cancellation_quote(principal, appointment, cause, now=now)
            if amount != fields["quoted_refund_amount"]:
                raise ApiProblem(
                    409, "CANCELLATION_QUOTE_CHANGED", "退金金额已更新，请核对后重新确认。",
                    details={"refund_amount": format(amount, ".2f")},
                )
            if cause == "CLINIC":
                require_coordination_evidence(appointment, fields)
                state_evidence(
                    principal, appointment, "CLINIC_CANCELLATION_COORDINATED", appointment.status,
                    coordination_evidence=fields.get("coordination_evidence"),
                )
            saved = finish_cancellation(principal, appointment, claim, fields["reason"], amount, now, party=cause)
        operation.record_result(saved.pk, fields)
        return saved
