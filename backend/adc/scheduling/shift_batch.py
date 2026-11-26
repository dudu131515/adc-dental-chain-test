from datetime import datetime, time, timedelta

from django.db.models import Exists, OuterRef

from adc.common.http import ApiProblem
from adc.identity.models import Clinic, Employee, EmployeeRole
from adc.scheduling.models import Shift
from adc.scheduling.shift_service import (
    BUSINESS_ZONE, draft_shift, publish_shift, shift_values, submit_shift, validate_shift_data,
)


ACTIVE_SHIFT_STATES = ("DRAFT", "PENDING", "ACCEPTED", "PUBLISHED")
BATCH_LIMIT = 200


def lock_resources(dentists, clinics):
    # Use the same employee-before-clinic order as single shift transitions.
    list(Employee.objects.filter(pk__in=dentists).order_by("pk").select_for_update())
    list(Clinic.objects.filter(pk__in=clinics).order_by("pk").select_for_update())


def visible_batch_sources(principal):
    scope = principal.clinic_scope("HQ_SCHEDULER")
    query = Shift.objects.all()
    return query if scope is None else query.filter(clinic_id__in=scope)


def load_sources(principal, ids):
    sources = visible_batch_sources(principal).in_bulk(ids)
    for shift_id in ids:
        if shift_id not in sources:
            raise ApiProblem(404, "NOT_FOUND", "找不到可办理的班次。", details={"shift_id": str(shift_id)})
    return [sources[shift_id] for shift_id in ids]


def refresh_sources(principal, sources):
    lock_resources({row.dentist_id for row in sources}, {row.clinic_id for row in sources})
    current = load_sources(principal, [row.pk for row in sources])
    for first, now in zip(sources, current):
        if shift_values(first) != shift_values(now) or first.status != now.status:
            raise ApiProblem(409, "SHIFT_CONFLICT", "班次已变动，请刷新再办理。", details={"shift_id": str(first.pk)})
    return current


def draft_copies(principal, rows):
    items = []
    skipped = 0
    clinics = {row["clinic_id"] for row in rows}
    lock_resources({row["dentist_id"] for row in rows}, clinics)
    for index, fields in enumerate(rows, start=1):
        try:
            validate_shift_data(principal, fields)
            identity = {key: value for key, value in fields.items() if key != "demand_id"}
            if Shift.objects.filter(**identity, status__in=ACTIVE_SHIFT_STATES).exists():
                skipped += 1
            else:
                items.append(draft_shift(principal, fields))
        except ApiProblem as error:
            error.details = {**error.details, "row": index}
            raise
    return items, skipped, clinics


def copy_fields(shift, days):
    return {
        "clinic_id": shift.clinic_id, "dentist_id": shift.dentist_id,
        "start_at": shift.start_at.astimezone(BUSINESS_ZONE) + timedelta(days=days),
        "end_at": shift.end_at.astimezone(BUSINESS_ZONE) + timedelta(days=days),
    }


def reuse_week(principal, data):
    target = data["target_week"]
    clinic_id = data.get("clinic_id")
    assigned = EmployeeRole.objects.filter(
        employee_id=OuterRef("dentist_id"), scope_clinic_id=OuterRef("clinic_id"), role__role_code="DENTIST",
    )
    query = visible_batch_sources(principal).filter(
        Exists(assigned),
        start_at__gte=datetime.combine(target - timedelta(days=7), time.min, BUSINESS_ZONE),
        start_at__lt=datetime.combine(target, time.min, BUSINESS_ZONE),
        clinic__status="ACTIVE", dentist__status="ACTIVE", status__in=ACTIVE_SHIFT_STATES,
    )
    if clinic_id is not None:
        principal.require("HQ_SCHEDULER", clinic_id)
        query = query.filter(clinic_id=clinic_id)
    if data.get("dentist_id"):
        query = query.filter(dentist_id=data["dentist_id"])
    sources = list(query.order_by("start_at", "pk")[:BATCH_LIMIT + 1])
    if len(sources) > BATCH_LIMIT:
        raise ApiProblem(400, "VALIDATION_ERROR", "上一周班次过多，请按门店或牙医分批复用。")
    sources = refresh_sources(principal, sources)
    return draft_copies(principal, [copy_fields(row, 7) for row in sources])


def run_shift_batch(principal, action, data):
    if action == "draft":
        return draft_copies(principal, data["shifts"])
    if action == "copy":
        source, = refresh_sources(principal, load_sources(principal, [data["source_shift_id"]]))
        if source.status == "CANCELLED":
            raise ApiProblem(409, "INVALID_TRANSITION", "已撤销班次不能复制。")
        days = (data["target_date"] - source.start_at.astimezone(BUSINESS_ZONE).date()).days
        try:
            fields = copy_fields(source, days)
        except OverflowError:
            raise ApiProblem(400, "VALIDATION_ERROR", "目标日期超出可办理范围。") from None
        return draft_copies(principal, [fields])
    if action == "reuse_week":
        return reuse_week(principal, data)

    entries = data["shifts"]
    sources = refresh_sources(principal, load_sources(principal, [entry["shift_id"] for entry in entries]))
    items = []
    for row, entry in zip(sources, entries):
        try:
            if action == "submit":
                items.append(submit_shift(principal, row))
            else:
                items.append(publish_shift(principal, row, entry.get("route_feasible"), entry.get("evidence_ref")))
        except ApiProblem as error:
            error.details = {**error.details, "shift_id": str(row.pk)}
            raise
    return items, 0, {row.clinic_id for row in sources}
