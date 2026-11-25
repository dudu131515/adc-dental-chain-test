from django.db import transaction
from django.utils import timezone

from adc.booking.deposit_service import create_deposit_refund
from adc.booking.models import DepositPayment
from adc.clinical.checkin_service import available_chairs, check_claim, lock_booking
from adc.clinical.models import ChairUsage, Visit
from adc.common.http import ApiProblem
from adc.identity.audit import record_event


def start_visit(principal, first, fields, operation):
    principal.require("DENTIST")
    if first.claim.dentist_id != principal.employee_id:
        raise ApiProblem(404, "NOT_FOUND", "找不到本人负责的预约。")
    with transaction.atomic():
        appointment, claim, shift = lock_booking(first)
        prior_result = operation.result_id(fields)
        if prior_result is not None:
            return Visit.objects.get(pk=prior_result), False
        check_claim(claim, fields["expected_claim_id"])
        existing = Visit.objects.filter(appointment=appointment).first()
        if existing:
            operation.record_result(existing.pk, fields)
            return existing, False
        if appointment.status != "CHECKED_IN" or claim.status != "CONFIRMED" or shift.status != "PUBLISHED":
            raise ApiProblem(409, "INVALID_TRANSITION", "请先核验有效预约、签到并分配牙椅。")
        at = timezone.now()
        seat = ChairUsage.objects.filter(appointment=appointment, released_at__isnull=True).first()
        if seat is None or not available_chairs(appointment, at).filter(pk=seat.chair_id).exists():
            raise ApiProblem(409, "RESOURCE_CONFLICT", "当前牙椅不可用，请先核对分椅。")
        if Visit.objects.filter(main_dentist_id=principal.employee_id, status="IN_PROGRESS").exists():
            raise ApiProblem(409, "RESOURCE_CONFLICT", "本人已有进行中的实际诊疗。")
        deposit = DepositPayment.objects.select_for_update().get(pk=appointment.deposit_id)
        visit = Visit.objects.create(
            appointment=appointment, main_dentist_id=principal.employee_id, started_at=at, status="IN_PROGRESS",
        )
        appointment.status, appointment.is_attended = "IN_TREATMENT", True
        appointment.save(update_fields=("status", "is_attended"))
        refund = create_deposit_refund(deposit, deposit.amount, "VISIT_STARTED", account_id=principal.account_id)
        details = {
            "appointment_id": str(appointment.pk), "claim_id": str(claim.pk), "chair_id": str(seat.chair_id),
            "started_at": at.isoformat(), "deposit_refund_id": str(refund.pk),
        }
        record_event(
            account_id=principal.account_id, action="VISIT_STARTED", target_type="visit", target_id=visit.pk,
            visible_fields=details.keys(), after=details,
        )
        operation.record_result(visit.pk, fields)
        return visit, True
