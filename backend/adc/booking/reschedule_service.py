from django.db import IntegrityError, connection, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone

from adc.booking.appointment_query import BOOKING_STAFF
from adc.booking.calendar import change_cutoff
from adc.booking.hold_service import validate_candidate
from adc.booking.models import Appointment, AppointmentChange, SlotClaim
from adc.common.http import ApiProblem, translate_integrity_error
from adc.identity.audit import record_event
from adc.identity.models import Clinic, Employee
from adc.scheduling.models import Shift


def require_coordinator(principal, clinic_id):
    if not any(principal.allows(role, clinic_id) for role in BOOKING_STAFF):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前人员缺少该门店的预约协调权限。")


def check_actor(principal, source, clinic_id, cause, consent):
    if principal.channel == "patient":
        if principal.patient_id != source.patient_id or cause != "PATIENT":
            raise ApiProblem(403, "PERMISSION_DENIED", "患者本人只能办理自己的患者原因改期。")
        return
    if cause == "PATIENT":
        principal.require("FRONT_DESK", source.clinic_id)
        principal.require("FRONT_DESK", clinic_id)
    else:
        require_coordinator(principal, source.clinic_id)
        require_coordinator(principal, clinic_id)
        if not consent:
            raise ApiProblem(400, "EVIDENCE_REQUIRED", "诊所原因改期须先取得患者明确同意。")


def lock_appointment_context(first, dentist_ids, clinic_ids, shift_ids, *, require_unchanged_claim=True):
    list(Employee.objects.filter(pk__in=dentist_ids).order_by("pk").select_for_update())
    list(Clinic.objects.filter(pk__in=clinic_ids).order_by("pk").select_for_update())
    shifts = {shift.pk: shift for shift in Shift.objects.filter(pk__in=shift_ids).order_by("pk").select_for_update()}
    appointment = get_object_or_404(Appointment.objects.select_for_update(), pk=first.pk)
    current = SlotClaim.objects.select_for_update().get(pk=appointment.claim_id)
    if require_unchanged_claim and current.pk != first.claim_id:
        raise ApiProblem(409, "STALE_APPOINTMENT", "预约已有更新，请刷新新旧安排。")
    return appointment, current, shifts


def reschedule(principal, first, fields, operation):
    original = first.claim
    destination = fields["clinic_id"]
    cause = fields["cause"]
    consent = fields.get("patient_consent_ref")
    check_actor(principal, original, destination, cause, consent)
    try:
        with transaction.atomic():
            appointment, current, shifts = lock_appointment_context(
                first, {original.dentist_id, fields["dentist_id"]},
                {original.clinic_id, destination}, {original.shift_id, fields["shift_id"]},
                require_unchanged_claim=False,
            )
            claim_changed = current.pk != original.pk
            if claim_changed:
                check_actor(principal, current, destination, cause, consent)
            preceding = operation.result_id(fields)
            if preceding is not None:
                return appointment
            if claim_changed or fields["expected_claim_id"] != current.pk:
                raise ApiProblem(409, "STALE_APPOINTMENT", "预约时段已变，请重新核对。")
            allowed_status = {"CONFIRMED", "CHECKED_IN"} if cause == "CLINIC" else {"CONFIRMED"}
            if appointment.is_attended or appointment.status not in allowed_status:
                raise ApiProblem(409, "INVALID_TRANSITION", "当前履约状态不能改期。")
            date_version = None
            now = timezone.now()
            if cause == "PATIENT":
                cutoff, date_version = change_cutoff(current.clinic_id, current.start_at)
                if now > cutoff:
                    raise ApiProblem(
                        409, "RESCHEDULE_CLOSED", "已超过原预约门店的患者改期截止。",
                        details={"change_deadline_at": cutoff.isoformat()},
                    )
            proposed = shifts.get(fields["shift_id"])
            if proposed is None or proposed.clinic_id != destination or proposed.dentist_id != fields["dentist_id"]:
                raise ApiProblem(409, "RESOURCE_CONFLICT", "找不到对应的目标班次。")
            start, end = fields["start_at"], fields["end_at"]
            if end - start != current.end_at - current.start_at:
                raise ApiProblem(400, "VALIDATION_ERROR", "改期须沿用已确认项目的预计占时。")
            SlotClaim.objects.filter(status="HOLD", expires_at__lte=now).filter(
                Q(clinic_id__in={destination, current.clinic_id}) | Q(dentist_id=proposed.dentist_id),
            ).update(status="EXPIRED")
            validate_candidate(
                proposed, current.requested_treatment_type, start, end, now,
                exclude_claim_id=current.pk, chair_kind=current.required_chair_kind,
            )
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS slot_claim_dentist_time_excl DEFERRED")
                new_claim = SlotClaim.objects.create(
                    patient_id=current.patient_id, clinic_id=destination, dentist_id=proposed.dentist_id,
                    shift=proposed, requested_treatment_type_id=current.requested_treatment_type_id,
                    required_chair_kind=current.required_chair_kind, start_at=start, end_at=end,
                    status="CONFIRMED",
                )
                prior_status = appointment.status
                appointment.claim, appointment.status = new_claim, "CONFIRMED"
                appointment.save(update_fields=("claim", "status"))
                current.status = "RELEASED"
                current.save(update_fields=("status",))
                if prior_status == "CHECKED_IN":
                    cursor.execute(
                        "UPDATE chair_usage SET released_at = %s WHERE appointment_id = %s AND released_at IS NULL",
                        [now, appointment.pk],
                    )
                cursor.execute("SET CONSTRAINTS slot_claim_dentist_time_excl IMMEDIATE")
            change = AppointmentChange.objects.create(
                appointment=appointment, change_type="RESCHEDULE", old_claim=current, new_claim=new_claim,
                reason=fields["reason"], changed_by_id=principal.employee_id, changed_by_patient_id=principal.patient_id,
            )
            evidence = {
                "cause": cause, "old_claim_id": str(current.pk), "new_claim_id": str(new_claim.pk),
                "old_clinic_id": str(current.clinic_id), "new_clinic_id": str(destination),
                "prior_status": prior_status, "work_calendar_version": date_version,
                "patient_consent_ref": consent, "reason": fields["reason"],
            }
            record_event(
                account_id=principal.account_id, action="APPOINTMENT_RESCHEDULED", target_type="appointment_change",
                target_id=change.pk, visible_fields=evidence.keys(), after=evidence,
            )
            operation.record_result(appointment.pk, fields)
            return appointment
    except IntegrityError as error:
        raise translate_integrity_error(error, {
            "slot_claim_dentist_time_excl": ("RESOURCE_CONFLICT", "目标时段有冲突，原预约仍然保留。"),
        })


def record_coordination(principal, original, fields, operation):
    require_coordinator(principal, original.claim.clinic_id)
    with transaction.atomic():
        appointment = get_object_or_404(Appointment.objects.select_for_update(), pk=original.pk)
        previous = operation.result_id(fields)
        if previous:
            return previous
        if appointment.claim_id != fields["expected_claim_id"] or appointment.claim_id != original.claim_id:
            raise ApiProblem(409, "STALE_APPOINTMENT", "预约已更新，请回查当前安排。")
        if appointment.is_attended or appointment.status not in {"CONFIRMED", "CHECKED_IN"}:
            raise ApiProblem(409, "INVALID_TRANSITION", "当前履约状态不能登记预约协调。")
        evidence = record_event(
            account_id=principal.account_id, action="APPOINTMENT_COORDINATION_INTENT",
            target_type="appointment", target_id=appointment.pk,
            visible_fields=("clinic_id", "claim_id", "impact", "patient_intent"),
            after={
                "clinic_id": str(original.claim.clinic_id), "claim_id": str(original.claim_id),
                "impact": fields["impact"], "patient_intent": fields["patient_intent"],
            },
        )
        operation.record_result(evidence.pk, fields)
        return evidence.pk
