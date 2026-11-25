from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from adc.booking.chair_capacity import Requirement, load_capacity
from adc.booking.reschedule_service import lock_appointment_context
from adc.clinical.models import ChairUsage
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog
from adc.scheduling.models import DentalChair


def lock_booking(first):
    claim = first.claim
    appointment, current, shifts = lock_appointment_context(
        first, {claim.dentist_id}, {claim.clinic_id}, {claim.shift_id},
    )
    return appointment, current, shifts[current.shift_id]


def check_claim(claim, expected):
    if claim.pk != expected:
        raise ApiProblem(409, "STALE_APPOINTMENT", "预约安排已变化，请刷新核对。")


def check_in(principal, first, fields, operation):
    principal.require("FRONT_DESK", first.claim.clinic_id)
    with transaction.atomic():
        appointment, claim, _ = lock_booking(first)
        if operation.result_id(fields) is not None:
            return appointment
        check_claim(claim, fields["expected_claim_id"])
        if appointment.status == "CHECKED_IN":
            return appointment
        if appointment.status != "CONFIRMED" or claim.status != "CONFIRMED" or appointment.deposit.status != "PAID":
            raise ApiProblem(409, "INVALID_TRANSITION", "只有有效预约可签到。")
        if not fields["identity_confirmed"]:
            raise ApiProblem(400, "EVIDENCE_REQUIRED", "请先核对到诊者身份。")
        appointment.status = "CHECKED_IN"
        appointment.save(update_fields=("status",))
        record_event(
            account_id=principal.account_id, action="APPOINTMENT_CHECKED_IN", target_type="appointment",
            target_id=appointment.pk, visible_fields=("claim_id", "clinic_id", "identity_confirmed"),
            after={"claim_id": str(claim.pk), "clinic_id": str(claim.clinic_id), "identity_confirmed": True},
        )
        operation.record_result(appointment.pk, fields)
        return appointment


def check_in_at(appointment):
    fact = AuditLog.objects.filter(
        action="APPOINTMENT_CHECKED_IN", target_type="appointment", target_id=appointment.pk,
        after_value__claim_id=str(appointment.claim_id),
    ).order_by("-pk").first()
    return fact.occurred_at.isoformat() if fact else None


def available_chairs(appointment, now):
    if appointment.status not in {"CHECKED_IN", "IN_TREATMENT"}:
        raise ApiProblem(409, "INVALID_TRANSITION", "请先为有效预约签到。")
    claim = appointment.claim
    capacity = load_capacity(claim.clinic_id, now, exclude_claim_id=claim.pk)
    staff_free = set(ChairUsage.objects.filter(
        chair__clinic_id=claim.clinic_id, released_at__isnull=True,
    ).exclude(appointment_id=appointment.pk).values_list("chair_id", flat=True))
    finish = max(claim.end_at, now + timedelta(microseconds=1))
    candidates = [
        chair.id for chair in capacity.chairs
        if chair.id not in staff_free and capacity.can_fit(
            Requirement(claim.pk, now, finish, claim.required_chair_kind, fixed_chair_id=chair.id)
        )
    ]
    return DentalChair.objects.filter(pk__in=candidates).order_by("chair_no")


def assign_chair(principal, first, fields, operation):
    principal.require("FRONT_DESK", first.claim.clinic_id)
    with transaction.atomic():
        appointment, claim, _ = lock_booking(first)
        preceding = operation.result_id(fields)
        if preceding is not None:
            return ChairUsage.objects.get(pk=preceding)
        check_claim(claim, fields["expected_claim_id"])
        now = timezone.now()
        chosen = fields["chair_id"]
        if not available_chairs(appointment, now).filter(pk=chosen).exists():
            raise ApiProblem(409, "RESOURCE_CONFLICT", "牙椅不能在所需区间分配，签到状态保持。")
        existing = ChairUsage.objects.select_for_update().filter(
            appointment=appointment, released_at__isnull=True,
        ).first()
        if existing and existing.chair_id == chosen:
            operation.record_result(existing.pk, fields)
            return existing
        if existing:
            existing.released_at = now
            existing.save(update_fields=("released_at",))
        usage = ChairUsage.objects.create(appointment=appointment, chair_id=chosen, assigned_at=now)
        record_event(
            account_id=principal.account_id, action="APPOINTMENT_CHAIR_ASSIGNED", target_type="appointment",
            target_id=appointment.pk, visible_fields=("claim_id", "previous_chair_id", "chair_id", "usage_id"),
            after={
                "claim_id": str(claim.pk), "previous_chair_id": str(existing.chair_id) if existing else None,
                "chair_id": str(chosen), "usage_id": str(usage.pk),
            },
        )
        operation.record_result(usage.pk, fields)
        return usage
