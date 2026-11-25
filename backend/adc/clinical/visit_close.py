from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.utils import timezone

from adc.clinical.checkin_service import lock_booking
from adc.clinical.models import ChairUsage, DentistWorkSession, TreatmentItem, Visit
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.reporting.period_locks import BUSINESS_ZONE, lock_period_for_end


class VisitQuarterChanged(Exception):
    pass


def duration_minutes(start, end):
    delta = end - start
    microseconds = (delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds
    if microseconds < 0:
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "结束时点早于实际开始时点，请核对。")
    return (Decimal(microseconds) / Decimal(60000000)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def close_visit(principal, original, fields, operation, *, terminated=False):
    previous = operation.result_id(fields)
    if previous is not None:
        return Visit.objects.get(pk=previous)
    while True:
        try:
            with transaction.atomic():
                period = lock_period_for_end(timezone.now())
                booking, claim, _shift = lock_booking(original.appointment)
                visit = Visit.objects.select_for_update().get(pk=original.pk)
                previous = operation.result_id(fields)
                if previous is not None:
                    return visit
                if visit.main_dentist_id != principal.employee_id or visit.status != "IN_PROGRESS":
                    raise ApiProblem(409, "INVALID_TRANSITION", "只有负责牙医可结束正在进行的诊疗。")
                if not terminated and not TreatmentItem.objects.filter(visit=visit).exists():
                    raise ApiProblem(409, "EVIDENCE_REQUIRED", "正常完成至少须保存一项实际治疗。")
                ended = timezone.now()
                local_end = ended.astimezone(BUSINESS_ZONE)
                if (local_end.year, (local_end.month - 1) // 3 + 1) != (period.perf_year, period.perf_quarter):
                    raise VisitQuarterChanged
                return commit_visit_close(principal, visit, booking, claim, ended, fields, operation, terminated, period.pk)
        except VisitQuarterChanged:
            continue


def commit_visit_close(principal, visit, booking, claim, ended, fields, operation, terminated, period_id):
    minutes = duration_minutes(visit.started_at, ended)
    visit.status = "TERMINATED" if terminated else "COMPLETED"
    visit.ended_at = ended
    visit.termination_reason = fields.get("reason") if terminated else None
    if "clinical_notes" in fields:
        visit.clinical_notes = fields["clinical_notes"]
    visit.save(update_fields=("status", "ended_at", "termination_reason", "clinical_notes"))
    DentistWorkSession.objects.create(
        visit=visit, dentist_id=visit.main_dentist_id,
        started_at=visit.started_at, ended_at=ended, duration_minutes=minutes,
    )
    ChairUsage.objects.filter(appointment=booking, released_at__isnull=True).update(released_at=ended)
    claim.status = "RELEASED"
    claim.save(update_fields=("status",))
    booking.status = "COMPLETED"
    booking.save(update_fields=("status",))
    facts = {
        "appointment_id": str(booking.pk), "claim_id": str(claim.pk), "status": visit.status,
        "ended_at": ended.isoformat(), "duration_minutes": format(minutes, ".2f"), "period_id": str(period_id),
        "reason": visit.termination_reason,
    }
    record_event(
        account_id=principal.account_id, action="VISIT_CLOSED", target_type="visit", target_id=visit.pk,
        visible_fields=facts.keys(), after=facts,
    )
    operation.record_result(visit.pk, fields)
    return visit
