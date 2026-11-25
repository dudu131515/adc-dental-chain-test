from django.db import connection, transaction

from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Clinic
from adc.scheduling.models import DentalChair, DentalChairUnavailability
from adc.scheduling.shift_service import lock_shift, require_status, transition_evidence


def active_appointments(*, shift_id=None, chair=None, start=None, end=None):
    query = """
        SELECT a.appointment_id, a.appointment_no, a.status, sc.claim_id, sc.clinic_id,
               sc.dentist_id, sc.start_at, sc.end_at
        FROM appointment AS a JOIN slot_claim AS sc ON sc.claim_id = a.claim_id
        WHERE a.status IN ('CONFIRMED', 'CHECKED_IN', 'IN_TREATMENT')
    """
    if shift_id is not None:
        query += " AND sc.shift_id = %s"
        params = [shift_id]
    else:
        query += """
          AND sc.clinic_id = %s AND sc.start_at < %s AND sc.end_at > %s
          AND (sc.required_chair_kind IS NULL OR sc.required_chair_kind = %s)
          AND NOT EXISTS (
                SELECT 1 FROM chair_usage AS cu
                WHERE cu.appointment_id = a.appointment_id AND cu.released_at IS NULL AND cu.chair_id <> %s
          )
        """
        params = [chair.clinic_id, end, start, chair.chair_kind, chair.pk]
    query += " ORDER BY sc.start_at, a.appointment_id"
    with connection.cursor() as cursor:
        cursor.execute(query, params)
        return [
            {
                "appointment_id": str(pk), "appointment_no": number, "status": status,
                "claim_id": str(claim), "clinic_id": str(clinic), "dentist_id": str(dentist),
                "start_at": starts.isoformat(), "end_at": ends.isoformat(),
            }
            for pk, number, status, claim, clinic, dentist, starts, ends in cursor.fetchall()
        ]


def withdraw_shift(principal, first, reason):
    with transaction.atomic():
        shift = lock_shift(first.pk, first)
        require_status(shift, "PUBLISHED")
        affected = active_appointments(shift_id=shift.pk)
        if affected:
            if not AuditLog.objects.filter(
                action="SHIFT_WITHDRAWAL_REQUESTED", target_type="shift", target_id=shift.pk,
            ).exists():
                record_event(
                    account_id=principal.account_id, action="SHIFT_WITHDRAWAL_REQUESTED",
                    target_type="shift", target_id=shift.pk, visible_fields=("clinic_id", "reason"),
                    after={"clinic_id": str(shift.clinic_id), "reason": reason},
                )
        else:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE slot_claim SET status = 'RELEASED' WHERE shift_id = %s AND status = 'HOLD'",
                    [shift.pk],
                )
            shift.status = "CANCELLED"
            shift.save(update_fields=("status",))
            transition_evidence(principal, shift, "PUBLISHED", reason=reason)
    if affected:
        raise ApiProblem(
            409, "SHIFT_CONFLICT", "已暂停该班次的新增预约，请先协调受影响的预约。",
            details={"appointments": affected},
        )
    return shift


def stop_chair(principal, first, start_at, end_at, reason):
    if end_at <= start_at:
        raise ApiProblem(400, "VALIDATION_ERROR", "结束时间须晚于开始时间。", field_errors={"end_at": "请核对停用区间。"})
    with transaction.atomic():
        Clinic.objects.select_for_update().get(pk=first.clinic_id)
        chair = DentalChair.objects.select_for_update().get(pk=first.pk, clinic_id=first.clinic_id)
        overlap = DentalChairUnavailability.objects.filter(chair=chair, start_at__lt=end_at, end_at__gt=start_at)
        if overlap.exists():
            raise ApiProblem(409, "RESOURCE_CONFLICT", "这把牙椅已有重叠的停用区间。")
        downtime = DentalChairUnavailability.objects.create(
            chair=chair, start_at=start_at, end_at=end_at, reason=reason,
        )
        record_event(
            account_id=principal.account_id, action="CHAIR_UNAVAILABLE", target_type="dental_chair_unavailability",
            target_id=downtime.pk, visible_fields=("clinic_id", "chair_id", "start_at", "end_at", "reason"),
            after={
                "clinic_id": str(chair.clinic_id),
                "chair_id": str(chair.pk),
                "start_at": start_at.isoformat(),
                "end_at": end_at.isoformat(),
                "reason": reason,
            },
        )
        return downtime, active_appointments(chair=chair, start=start_at, end=end_at)
