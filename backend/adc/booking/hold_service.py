from datetime import datetime, time, timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone

from adc.booking.chair_capacity import Requirement, load_capacity
from adc.booking.models import Appointment, DepositPayment, SlotClaim
from adc.booking.patient_api import patients_in_clinic
from adc.catalog.models import TreatmentType
from adc.common.http import ApiProblem, translate_integrity_error
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Clinic, Employee, Patient
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.models import Shift
from adc.scheduling.shift_service import qualified


HOLD_TIME = timedelta(minutes=10)
DEPOSIT_AMOUNT = Decimal("50.00")
USE_CATALOG_CHAIR = object()


def booking_subject(principal, clinic_id, patient_id):
    if principal.channel == "patient":
        if patient_id is not None and patient_id != principal.patient_id:
            raise ApiProblem(403, "PERMISSION_DENIED", "本人预约不能指定其他患者。")
        return principal.patient_id
    principal.require("FRONT_DESK", clinic_id)
    if patient_id is None:
        raise ApiProblem(400, "VALIDATION_ERROR", "请先选择本店代办患者。")
    get_object_or_404(patients_in_clinic(clinic_id), pk=patient_id)
    return patient_id


def duration_for(principal, treatment, estimated_minutes, estimate_evidence):
    if treatment.default_slot_minutes is not None:
        return treatment.default_slot_minutes
    if principal.channel != "staff" or not estimated_minutes or not estimate_evidence:
        raise ApiProblem(
            400, "EVIDENCE_REQUIRED", "本项目需由牙医估时，再由授权前台代办。",
        )
    return estimated_minutes


def valid_claims(as_of):
    return SlotClaim.objects.filter(Q(status="CONFIRMED") | Q(status="HOLD", expires_at__gt=as_of))


def doctor_free(doctor, start, end, now, *, exclude_claim_id=None):
    overlapping = valid_claims(now).filter(dentist_id=doctor, start_at__lt=end, end_at__gt=start)
    if exclude_claim_id is not None:
        overlapping = overlapping.exclude(pk=exclude_claim_id)
    return not overlapping.exists()


def withdrawal_requests():
    return AuditLog.objects.filter(
        action="SHIFT_WITHDRAWAL_REQUESTED", target_type="shift",
    ).values("target_id")


def candidate_times(start, finish, duration, boundaries):
    starts = {start, *(at for at in boundaries if start < at < finish)}
    proposed = set()
    for anchor in starts:
        while anchor + duration <= finish and anchor not in proposed:
            proposed.add(anchor)
            anchor += duration
    return sorted(proposed)


def list_available(
    principal, clinic_id, service_date, treatment_id, dentist_id=None, estimated=None, evidence=None,
    *, previous=None, preferred=None, exclude_shift_id=None,
):
    if principal.channel != "patient":
        if previous is None:
            principal.require("FRONT_DESK", clinic_id)
        elif not any(principal.allows(role, clinic_id) for role in ("FRONT_DESK", "CLINIC_MANAGER", "HQ_SCHEDULER")):
            raise ApiProblem(403, "PERMISSION_DENIED", "当前人员缺少目标门店的预约承接权限。")
    get_object_or_404(Clinic, pk=clinic_id, status="ACTIVE")
    if previous is None:
        treatment = get_object_or_404(TreatmentType, pk=treatment_id, active=True)
        minutes = duration_for(principal, treatment, estimated, evidence)
        if treatment.default_slot_minutes is None and dentist_id is None:
            raise ApiProblem(400, "EVIDENCE_REQUIRED", "复杂项目估时须对应已确认的牙医。")
        duration, chair_kind = timedelta(minutes=minutes), treatment.required_chair_kind
    else:
        treatment = previous.requested_treatment_type
        duration, chair_kind = previous.end_at - previous.start_at, previous.required_chair_kind
        minutes = int(duration.total_seconds() / 60)
    now = timezone.now()
    beginning = datetime.combine(service_date, time.min, BUSINESS_ZONE)
    ending = beginning + timedelta(days=1)
    shifts = Shift.objects.filter(
        clinic_id=clinic_id, status="PUBLISHED", start_at__lt=ending, end_at__gt=beginning, dentist__status="ACTIVE",
    ).exclude(pk__in=withdrawal_requests()).select_related("dentist")
    if exclude_shift_id is not None:
        shifts = shifts.exclude(pk=exclude_shift_id)
    if dentist_id is not None:
        shifts = shifts.filter(dentist_id=dentist_id)
    capacity = load_capacity(clinic_id, now, exclude_claim_id=previous.pk if previous else None)
    claimed = valid_claims(now).filter(start_at__lt=ending, end_at__gt=beginning)
    if previous is not None:
        claimed = claimed.exclude(pk=previous.pk)
    added = [interval.end for chair in capacity.chairs for interval in chair.blocked if interval.end is not None]
    items = []
    for shift in shifts.order_by("start_at", "dentist_id", "pk"):
        start, end = max(beginning, shift.start_at, now), min(ending, shift.end_at)
        other = list(claimed.filter(dentist_id=shift.dentist_id).values_list("start_at", "end_at"))
        starts = [preferred] if preferred is not None and start <= preferred and preferred + duration <= end else []
        if preferred is None:
            starts = candidate_times(start, end, duration, added + [right for _, right in other])
        for candidate in starts:
            finish = candidate + duration
            if any(left < finish and candidate < right for left, right in other):
                continue
            if not qualified(shift.dentist_id, treatment.required_qualification_id, candidate, finish):
                continue
            requirement = Requirement(0, candidate, finish, chair_kind)
            if not capacity.can_fit(requirement):
                continue
            items.append({
                "clinic_id": str(clinic_id), "dentist_id": str(shift.dentist_id),
                "dentist_name": shift.dentist.full_name, "shift_id": str(shift.pk),
                "treatment_type_id": str(treatment.pk), "start_at": candidate.isoformat(), "end_at": finish.isoformat(),
            })
    return {"items": items, "next_cursor": None, "estimated_minutes": minutes}


def validate_candidate(shift, treatment, start_at, end_at, now, *, exclude_claim_id=None, chair_kind=USE_CATALOG_CHAIR):
    if (
        shift.status != "PUBLISHED" or AuditLog.objects.filter(
            action="SHIFT_WITHDRAWAL_REQUESTED", target_type="shift", target_id=shift.pk,
        ).exists()
        or not Clinic.objects.filter(pk=shift.clinic_id, status="ACTIVE").exists()
        or not Employee.objects.filter(pk=shift.dentist_id, status="ACTIVE").exists()
        or start_at < now or start_at < shift.start_at or end_at > shift.end_at
        or not qualified(shift.dentist_id, treatment.required_qualification_id, start_at, end_at)
    ):
        raise ApiProblem(409, "RESOURCE_CONFLICT", "班次或牙医资格已变化，请重新选择时段。")
    if not doctor_free(shift.dentist_id, start_at, end_at, now, exclude_claim_id=exclude_claim_id):
        raise ApiProblem(409, "RESOURCE_CONFLICT", "牙医在该时段已安排预约。")
    capacity = load_capacity(shift.clinic_id, now, exclude_claim_id=exclude_claim_id)
    needed_kind = treatment.required_chair_kind if chair_kind is USE_CATALOG_CHAIR else chair_kind
    requirement = Requirement(exclude_claim_id or 0, start_at, end_at, needed_kind)
    if not capacity.can_fit(requirement):
        raise ApiProblem(409, "RESOURCE_CONFLICT", "该时段没有整段可用的适配牙椅，请重新选择。")


def create_hold(principal, data, operation):
    clinic_id, dentist_id, patient_id = data["clinic_id"], data["dentist_id"], data["patient_id"]
    try:
        with transaction.atomic():
            get_object_or_404(Employee.objects.select_for_update(), pk=dentist_id, status="ACTIVE")
            get_object_or_404(Clinic.objects.select_for_update(), pk=clinic_id, status="ACTIVE")
            shift = get_object_or_404(Shift.objects.select_for_update(), pk=data["shift_id"], clinic_id=clinic_id, dentist_id=dentist_id)
            get_object_or_404(Patient.objects.select_for_update(), pk=patient_id)
            now = timezone.now()
            previous = operation.result_id(data)
            if previous is not None:
                return SlotClaim.objects.get(pk=previous), now, False
            booking_subject(principal, clinic_id, patient_id)
            treatment = get_object_or_404(TreatmentType, pk=data["treatment_type_id"], active=True)
            extras = data.get("other_treatment_ids", [])
            if extras and TreatmentType.objects.filter(active=True, pk__in=extras).count() != len(extras):
                raise ApiProblem(400, "VALIDATION_ERROR", "其他治疗意向包含不可选项目。")
            duration = duration_for(principal, treatment, data.get("estimated_minutes"), data.get("estimate_evidence"))
            start, finish = data["start_at"], data["end_at"]
            if finish - start != timedelta(minutes=duration):
                raise ApiProblem(400, "VALIDATION_ERROR", "预约起止时间须与项目预计占时一致。")
            SlotClaim.objects.filter(status="HOLD", expires_at__lte=now).filter(
                Q(clinic_id=clinic_id) | Q(dentist_id=dentist_id),
            ).update(status="EXPIRED")
            validate_candidate(shift, treatment, start, finish, now)
            hold = SlotClaim.objects.create(
                patient_id=patient_id, clinic_id=clinic_id, dentist_id=dentist_id, shift=shift,
                requested_treatment_type=treatment, required_chair_kind=treatment.required_chair_kind,
                start_at=start, end_at=finish, expires_at=now + HOLD_TIME, status="HOLD",
            )
            DepositPayment.objects.create(claim=hold, status="PENDING", amount=DEPOSIT_AMOUNT)
            operation.record_result(hold.pk, data)
            context = {key: data[key] for key in ("estimated_minutes", "estimate_evidence", "other_treatment_ids", "special_requirement") if key in data}
            if context:
                record_event(
                    account_id=principal.account_id, action="HOLD_CONTEXT", target_type="slot_claim", target_id=hold.pk,
                    visible_fields=context.keys(), after=context,
                )
            return hold, now, True
    except IntegrityError as error:
        raise translate_integrity_error(error, {
            "slot_claim_dentist_time_excl": ("RESOURCE_CONFLICT", "时段已有预约，请重新选择。"),
        })


def scope_hold(request, pk):
    principal = request.user
    query = SlotClaim.objects.filter(depositpayment__isnull=False)
    if principal.channel == "patient":
        query = query.filter(patient_id=principal.patient_id)
    else:
        principal.require("FRONT_DESK")
        query = query.filter(clinic_id__in=principal.clinic_scope("FRONT_DESK"))
    return get_object_or_404(query, pk=pk)


def hold_projection(hold, now):
    payment = DepositPayment.objects.get(claim=hold)
    appointment = Appointment.objects.filter(deposit=payment).first()
    hold_state = "EXPIRED" if hold.status == "HOLD" and hold.expires_at <= now else hold.status
    return {
        "claim_id": str(hold.pk), "status": hold_state, "clinic_id": str(hold.clinic_id),
        "dentist_id": str(hold.dentist_id), "start_at": hold.start_at.isoformat(), "end_at": hold.end_at.isoformat(),
        "expires_at": hold.expires_at.isoformat() if hold.expires_at else None, "server_time": now.isoformat(),
        "payment": {"deposit_id": str(payment.pk), "amount": format(payment.amount, ".2f"), "status": payment.client_status},
        "appointment_id": str(appointment.pk) if appointment else None,
        "appointment_no": appointment.appointment_no if appointment else None,
    }
