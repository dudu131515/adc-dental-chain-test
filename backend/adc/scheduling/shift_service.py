from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import Clinic, Employee, EmployeeRole
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.models import EmployeeQualification, Shift, ShiftDemand


def shift_problem(message, code="SHIFT_CONFLICT"):
    return ApiProblem(409, code, message)


def date_range(start, end):
    return start.astimezone(BUSINESS_ZONE).date(), (end - timedelta(microseconds=1)).astimezone(BUSINESS_ZONE).date()


def qualified(dentist_id, qualification_id, start, end):
    if not qualification_id:
        return True
    first, last = date_range(start, end)
    return EmployeeQualification.objects.filter(
        employee_id=dentist_id, qualification_id=qualification_id,
    ).filter(
        Q(valid_from__isnull=True) | Q(valid_from__lte=first),
        Q(valid_until__isnull=True) | Q(valid_until__gte=last),
    ).exists()


def validate_shift_data(principal, data):
    start, end = data["start_at"], data["end_at"]
    if start >= end:
        raise ApiProblem(400, "VALIDATION_ERROR", "结束时间须晚于开始时间。", field_errors={"end_at": "请核对班次结束时间。"})
    clinic_id, dentist_id = data["clinic_id"], data["dentist_id"]
    principal.require("HQ_SCHEDULER", clinic_id)
    if not Clinic.objects.filter(pk=clinic_id, status="ACTIVE").exists():
        raise ApiProblem(404, "NOT_FOUND", "找不到可排班的门店。")
    if not EmployeeRole.objects.filter(
        employee_id=dentist_id, employee__status="ACTIVE", role__role_code="DENTIST",
        scope_clinic_id=clinic_id,
    ).exists():
        raise ApiProblem(400, "VALIDATION_ERROR", "该员工不在本店的可排牙医范围。")
    if data.get("demand_id") and not ShiftDemand.objects.filter(
        pk=data["demand_id"], clinic_id=clinic_id,
    ).exists():
        raise ApiProblem(404, "NOT_FOUND", "找不到本店对应的排班需求。")


def shift_values(shift):
    return {
        "clinic_id": shift.clinic_id,
        "dentist_id": shift.dentist_id,
        "demand_id": shift.demand_id,
        "start_at": shift.start_at,
        "end_at": shift.end_at,
    }


def transition_evidence(principal, shift, from_status, **details):
    target = {
        "status": shift.status, "clinic_id": str(shift.clinic_id), "dentist_id": str(shift.dentist_id),
        "start_at": shift.start_at.isoformat(), "end_at": shift.end_at.isoformat(),
    }
    record_event(
        account_id=principal.account_id, action="SHIFT_CHANGED", target_type="shift", target_id=shift.pk,
        visible_fields=("status", "clinic_id", "dentist_id", "start_at", "end_at", "reason", "evidence_ref"),
        before={"status": from_status} if from_status else None, after={**target, **details},
    )


def lock_shift(shift_id, first, *, new_dentist=None, new_clinic=None):
    list(Employee.objects.filter(pk__in={first.dentist_id, new_dentist}).order_by("pk").select_for_update())
    list(Clinic.objects.filter(pk__in={first.clinic_id, new_clinic}).order_by("pk").select_for_update())
    shift = Shift.objects.select_for_update().get(pk=shift_id)
    if (shift.dentist_id, shift.clinic_id) != (first.dentist_id, first.clinic_id):
        raise shift_problem("排班归属已变动，请刷新。")
    return shift


def require_status(shift, *allowed):
    if shift.status not in allowed:
        raise shift_problem("当前班次状态不允许此操作。", "INVALID_TRANSITION")


def check_conflicts(shift):
    if shift.demand_id and not qualified(
        shift.dentist_id, shift.demand.required_qualification_id, shift.start_at, shift.end_at,
    ):
        raise shift_problem("牙医所需资格未覆盖班次整段。")
    arrangements = Shift.objects.filter(
        dentist_id=shift.dentist_id, status="PUBLISHED",
    ).exclude(pk=shift.pk)
    if arrangements.filter(start_at__lt=shift.end_at, end_at__gt=shift.start_at).exists():
        raise shift_problem("牙医已有重叠的已发布班次。")
    previous = arrangements.filter(end_at__lte=shift.start_at).order_by("-end_at", "-pk").first()
    following = arrangements.filter(start_at__gte=shift.end_at).order_by("start_at", "pk").first()
    gaps = []
    if previous and previous.clinic_id != shift.clinic_id:
        gaps.append(shift.start_at - previous.end_at)
    if following and following.clinic_id != shift.clinic_id:
        gaps.append(following.start_at - shift.end_at)
    if any(gap < timedelta(minutes=60) for gap in gaps):
        raise shift_problem("跨店相邻班次须至少留出 60 分钟。")
    return bool(gaps)


def draft_shift(principal, data):
    with transaction.atomic():
        validate_shift_data(principal, data)
        shift = Shift.objects.create(**data, status="DRAFT")
        transition_evidence(principal, shift, None)
        return shift


def edit_shift(principal, first, details, expected_status, reason):
    with transaction.atomic():
        shift = lock_shift(first.pk, first, new_dentist=details.get("dentist_id"), new_clinic=details.get("clinic_id"))
        require_status(shift, "DRAFT", "REJECTED")
        if shift.status != expected_status:
            raise shift_problem("班次状态已变动，请刷新后重试。", "INVALID_TRANSITION")
        applied = {**shift_values(shift), **details}
        validate_shift_data(principal, applied)
        old_status = shift.status
        for name, value in applied.items():
            setattr(shift, name, value)
        shift.status, shift.doctor_response_at = "DRAFT", None
        shift.save(update_fields=(*applied, "status", "doctor_response_at"))
        transition_evidence(principal, shift, old_status, reason=reason)
        return shift


def submit_shift(principal, first):
    with transaction.atomic():
        shift = lock_shift(first.pk, first)
        require_status(shift, "DRAFT")
        validate_shift_data(principal, shift_values(shift))
        check_conflicts(shift)
        shift.status = "PENDING"
        shift.save(update_fields=("status",))
        transition_evidence(principal, shift, "DRAFT")
        return shift


def respond_to_shift(principal, first, decision, reason):
    with transaction.atomic():
        shift = lock_shift(first.pk, first)
        require_status(shift, "PENDING")
        shift.status, shift.doctor_response_at = decision, timezone.now()
        shift.save(update_fields=("status", "doctor_response_at"))
        transition_evidence(principal, shift, "PENDING", reason=reason)
        return shift


def publish_shift(principal, first, route_feasible, evidence_ref):
    with transaction.atomic():
        shift = lock_shift(first.pk, first)
        require_status(shift, "ACCEPTED")
        validate_shift_data(principal, shift_values(shift))
        cross_clinic = check_conflicts(shift)
        if cross_clinic and (route_feasible is not True or not evidence_ref):
            raise shift_problem("跨店路线尚未核对可行。")
        shift.status, shift.published_at = "PUBLISHED", timezone.now()
        shift.save(update_fields=("status", "published_at"))
        transition_evidence(principal, shift, "ACCEPTED", evidence_ref=evidence_ref)
        return shift
