from datetime import date, datetime, time, timedelta

from django.db import connection, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey, canonical_digest
from adc.common.serializers import ID, values
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Clinic, Employee, EmployeeRole
from adc.scheduling.models import EmployeeQualification, Qualification, Shift, ShiftDemand
from adc.scheduling.shift_batch import BATCH_LIMIT, load_sources, run_shift_batch
from adc.scheduling.shift_insights import rejection_reasons, shift_conflicts, staffing_shortages
from adc.scheduling.shift_service import (
    BUSINESS_ZONE, draft_shift, edit_shift, publish_shift, respond_to_shift, submit_shift,
)


SCHEDULER = "HQ_SCHEDULER"
MANAGER = "CLINIC_MANAGER"
BOARD = ("FRONT_DESK", MANAGER, SCHEDULER)
CLINIC_ROLES = ("FRONT_DESK", "DENTIST", MANAGER, SCHEDULER, "HQ_OPERATIONS_QUERY")


class ShiftFields(serializers.Serializer):
    clinic_id = ID()
    dentist_id = ID()
    demand_id = ID(required=False, allow_null=True)
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()


class DemandFields(serializers.Serializer):
    clinic_id = ID()
    required_qualification_id = ID(required=False, allow_null=True)
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()
    required_count = serializers.IntegerField(min_value=1, max_value=2**31 - 1)

    def validate(self, data):
        if data["end_at"] <= data["start_at"]:
            raise serializers.ValidationError({"end_at": "结束时间须晚于开始时间。"})
        return data


class ShiftEdit(ShiftFields):
    expected_status = serializers.ChoiceField(choices=("DRAFT", "REJECTED"))
    reason = serializers.CharField()


class ShiftRespond(serializers.Serializer):
    decision = serializers.ChoiceField(choices=("ACCEPTED", "REJECTED"))
    reason = serializers.CharField(required=False, allow_blank=True)

    def validate(self, data):
        if data["decision"] == "REJECTED" and not data.get("reason"):
            raise serializers.ValidationError({"reason": "拒绝班次时请填写原因。"})
        return data


class ShiftPublish(serializers.Serializer):
    route_feasible = serializers.BooleanField(required=False)
    evidence_ref = serializers.CharField(required=False)


class BatchAction(serializers.Serializer):
    action = serializers.ChoiceField(choices=("draft", "copy", "reuse_week", "submit", "publish"))


class BatchDraft(serializers.Serializer):
    shifts = ShiftFields(many=True, allow_empty=False, max_length=BATCH_LIMIT)


class BatchCopy(serializers.Serializer):
    source_shift_id = ID()
    target_date = serializers.DateField()


class BatchReuse(serializers.Serializer):
    target_week = serializers.DateField()
    clinic_id = ID(required=False)
    dentist_id = ID(required=False)

    def validate_target_week(self, week):
        if not 7 < week.toordinal() <= date.max.toordinal() - 7:
            raise serializers.ValidationError("目标周超出可办理范围。")
        return week


class BatchSubmitItem(serializers.Serializer):
    shift_id = ID()


class BatchPublishItem(ShiftPublish):
    shift_id = ID()


class BatchSubmit(serializers.Serializer):
    shifts = BatchSubmitItem(many=True, allow_empty=False, max_length=BATCH_LIMIT)

    def validate_shifts(self, items):
        if len({row["shift_id"] for row in items}) != len(items):
            raise serializers.ValidationError("每个班次只能选择一次。")
        return items


class BatchPublish(BatchSubmit):
    shifts = BatchPublishItem(many=True, allow_empty=False, max_length=BATCH_LIMIT)


class BoardFilter(serializers.Serializer):
    clinic_id = ID(required=False)
    dentist_id = ID(required=False)
    date_from = serializers.DateField(required=False)
    date_to = serializers.DateField(required=False)
    status = serializers.CharField(required=False)
    view = serializers.ChoiceField(choices=("day", "week", "list"), required=False)

    def validate(self, filters):
        first = filters.get("date_from", timezone.localdate())
        last = filters.get("date_to", first)
        if last < first:
            raise serializers.ValidationError({"date_to": "结束日期须不早于开始日期。"})
        if last == date.max:
            raise serializers.ValidationError({"date_to": "结束日期超出可查询范围。"})
        return {**filters, "date_from": first, "date_to": last}


def require_any(principal, *roles):
    if not any(principal.allows(role) for role in roles):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能访问排班资料。")


def scoped(query, scope):
    return query if scope is None else query.filter(clinic_id__in=scope)


def selected_clinic(request, roles):
    raw = request.query_params.get("clinic_id")
    if raw is None:
        return None
    clinic_id = int(raw) if raw.isascii() and raw.isdecimal() and len(raw) <= 19 else 0
    if not clinic_id or clinic_id > 2**63 - 1:
        raise ApiProblem(400, "VALIDATION_ERROR", "门店编号无效。")
    if not any(request.user.allows(role, clinic_id) for role in roles):
        raise ApiProblem(404, "NOT_FOUND", "找不到可访问的门店。")
    return clinic_id


def shift_data(shift):
    return {
        "shift_id": str(shift.pk), "clinic_id": str(shift.clinic_id), "dentist_id": str(shift.dentist_id),
        "demand_id": str(shift.demand_id) if shift.demand_id else None,
        "start_at": shift.start_at.isoformat(), "end_at": shift.end_at.isoformat(), "status": shift.status,
        "doctor_response_at": shift.doctor_response_at.isoformat() if shift.doctor_response_at else None,
        "published_at": shift.published_at.isoformat() if shift.published_at else None,
    }


def demand_data(demand):
    return {
        "demand_id": str(demand.pk), "clinic_id": str(demand.clinic_id),
        "required_qualification_id": str(demand.required_qualification_id) if demand.required_qualification_id else None,
        "start_at": demand.start_at.isoformat(), "end_at": demand.end_at.isoformat(),
        "status": demand.status, "required_count": demand.required_count,
    }


def visible_shifts(principal, roles, *, published_for_front_desk=False):
    scope = principal.clinic_scope(*roles)
    if scope is None:
        return Shift.objects.all()
    condition = Q(clinic_id__in=scope)
    if published_for_front_desk:
        condition |= Q(clinic_id__in=principal.clinic_scope("FRONT_DESK"), status="PUBLISHED")
    if principal.allows("DENTIST"):
        condition |= Q(dentist_id=principal.employee_id, clinic_id__in=principal.clinic_scope("DENTIST"))
    return Shift.objects.filter(condition)


def doctor_schedule_object(request, pk):
    request.user.require("DENTIST")
    return get_object_or_404(
        Shift, pk=pk, dentist_id=request.user.employee_id, clinic_id__in=request.user.clinic_scope("DENTIST"),
    )


def scheduler_object(request, pk):
    request.user.require(SCHEDULER)
    return get_object_or_404(scoped(Shift.objects.all(), request.user.clinic_scope(SCHEDULER)), pk=pk)


@api_view(["GET"])
def clinics(request):
    query = Clinic.objects.filter(status="ACTIVE")
    if request.user.channel != "patient":
        require_any(request.user, *CLINIC_ROLES)
        scope = request.user.clinic_scope(*CLINIC_ROLES)
        if scope is not None:
            query = query.filter(pk__in=scope)
    return success({
        "items": [{"clinic_id": str(clinic.pk), "name": clinic.clinic_name, "address": clinic.postal_address,
                   "phone": clinic.phone}
                  for clinic in query.order_by("clinic_no")],
        "next_cursor": None,
    })


@api_view(["GET"])
def qualifications(request):
    require_any(request.user, SCHEDULER, MANAGER, "HQ_CATALOG")
    return success({
        "items": [{"qualification_id": str(record.pk), "code": record.qualification_code, "name": record.qualification_name}
                  for record in Qualification.objects.order_by("qualification_code")],
        "next_cursor": None,
    })


@api_view(["GET"])
def dentists(request):
    roles = (SCHEDULER, MANAGER, "FRONT_DESK", "DENTIST")
    require_any(request.user, *roles)
    clinic_id = selected_clinic(request, roles)
    directory_scope = request.user.clinic_scope(SCHEDULER, MANAGER, "FRONT_DESK")
    licensed_scope = request.user.clinic_scope(SCHEDULER, MANAGER)
    candidates = EmployeeRole.objects.filter(
        role__role_code="DENTIST", scope_clinic__isnull=False, employee__status="ACTIVE",
    )
    if directory_scope is not None:
        condition = Q(scope_clinic_id__in=directory_scope)
        if request.user.allows("DENTIST"):
            condition |= Q(employee_id=request.user.employee_id, scope_clinic_id__in=request.user.clinic_scope("DENTIST"))
        candidates = candidates.filter(condition)
    if clinic_id is not None:
        candidates = candidates.filter(scope_clinic_id=clinic_id)
    clinics_by_employee = {}
    for employee_id, scope_clinic_id in candidates.values_list("employee_id", "scope_clinic_id").order_by("scope_clinic_id"):
        clinics_by_employee.setdefault(employee_id, []).append(str(scope_clinic_id))
    people = Employee.objects.filter(pk__in=clinics_by_employee).order_by("employee_no")
    qualified_people = candidates if licensed_scope is None else candidates.filter(scope_clinic_id__in=licensed_scope)
    licenses = EmployeeQualification.objects.filter(
        employee_id__in=qualified_people.values("employee_id"),
    ).select_related("qualification")
    by_employee = {}
    for record in licenses:
        by_employee.setdefault(record.employee_id, []).append({
            "qualification_id": str(record.qualification_id),
            "name": record.qualification.qualification_name,
            "valid_from": record.valid_from.isoformat() if record.valid_from else None,
            "valid_until": record.valid_until.isoformat() if record.valid_until else None,
        })
    return success({
        "items": [{"dentist_id": str(employee.pk), "name": employee.full_name, "qualifications": by_employee.get(employee.pk, []), "clinic_ids": clinics_by_employee[employee.pk]}
                  for employee in people],
        "next_cursor": None,
    })


@api_view(["GET", "POST"])
def demands(request):
    if request.method == "GET":
        require_any(request.user, SCHEDULER, MANAGER)
        clinic_id = selected_clinic(request, (SCHEDULER, MANAGER))
        query = scoped(ShiftDemand.objects.all(), request.user.clinic_scope(SCHEDULER, MANAGER))
        if clinic_id is not None:
            query = query.filter(clinic_id=clinic_id)
        return success({"items": [demand_data(row) for row in query.order_by("start_at", "pk")], "next_cursor": None})

    data = values(DemandFields, request.data)
    request.user.require(MANAGER, data["clinic_id"])
    get_object_or_404(Clinic, pk=data["clinic_id"], status="ACTIVE")
    if data.get("required_qualification_id"):
        get_object_or_404(Qualification, pk=data["required_qualification_id"])
    with transaction.atomic():
        demand = ShiftDemand.objects.create(**data)
        record_event(
            account_id=request.user.account_id, action="SHIFT_DEMAND_CREATED", target_type="shift_demand",
            target_id=demand.pk, visible_fields=("clinic_id", "start_at", "end_at", "required_count"),
            after=demand_data(demand),
        )
    return success(demand_data(demand), status_code=201)


@api_view(["GET", "POST"])
def shifts(request):
    if request.method == "POST":
        request.user.require(SCHEDULER)
        return success(shift_data(draft_shift(request.user, values(ShiftFields, request.data))), status_code=201)
    require_any(request.user, SCHEDULER, MANAGER, "DENTIST")
    clinic_id = selected_clinic(request, (SCHEDULER, MANAGER, "DENTIST"))
    query = visible_shifts(request.user, (SCHEDULER, MANAGER))
    if clinic_id is not None:
        query = query.filter(clinic_id=clinic_id)
    return success({"items": [shift_data(row) for row in query.order_by("start_at", "pk")], "next_cursor": None})


@api_view(["PATCH"])
def patch_shift(request, pk):
    first = scheduler_object(request, pk)
    data = values(ShiftEdit, request.data, partial=True)
    if not data.get("expected_status") or not data.get("reason"):
        raise ApiProblem(400, "VALIDATION_ERROR", "调整班次须提供原状态和原因。")
    expected = data.pop("expected_status")
    reason = data.pop("reason")
    return success(shift_data(edit_shift(request.user, first, data, expected, reason)))


@api_view(["POST"])
def submit(request, pk):
    return success(shift_data(submit_shift(request.user, scheduler_object(request, pk))))


@api_view(["POST"])
def respond(request, pk):
    first = doctor_schedule_object(request, pk)
    data = values(ShiftRespond, request.data)
    return success(shift_data(respond_to_shift(request.user, first, data["decision"], data.get("reason"))))


@api_view(["POST"])
def publish(request, pk):
    first = scheduler_object(request, pk)
    data = values(ShiftPublish, request.data)
    return success(shift_data(publish_shift(request.user, first, data.get("route_feasible"), data.get("evidence_ref"))))


@api_view(["POST"])
def batch_shifts(request):
    principal = request.user
    principal.require(SCHEDULER)
    action = values(BatchAction, request.data)["action"]
    serializer = {"draft": BatchDraft, "copy": BatchCopy, "reuse_week": BatchReuse, "submit": BatchSubmit, "publish": BatchPublish}
    data = values(serializer[action], request.data)
    operation = None
    if request.headers.get("Idempotency-Key"):
        operation = OperationKey.from_request(request, command="shift_batch", target={})
    with transaction.atomic():
        if operation:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [operation.scope_digest])
            digest = canonical_digest({"action": action, **data})
            prior = AuditLog.objects.filter(
                account_id=principal.account_id, action="IDEMPOTENCY_RESULT", target_type=operation.command,
                after_value__scope_digest=operation.scope_digest,
            ).first()
            if prior:
                receipt = prior.after_value
                if receipt["payload_digest"] != digest:
                    raise ApiProblem(409, "IDEMPOTENCY_CONFLICT", "办理标识已经用于不同的内容。")
                result = receipt["result"]
                load_sources(principal, [int(item["shift_id"]) for item in result["items"]])
                for clinic_id in receipt["clinic_ids"]:
                    principal.require(SCHEDULER, clinic_id)
                return success(result)

        items, skipped, clinic_ids = run_shift_batch(principal, action, data)
        result = {"items": [shift_data(row) for row in items], "skipped_count": skipped}
        if operation:
            if data.get("clinic_id"):
                clinic_ids.add(data["clinic_id"])
            AuditLog.objects.create(
                account_id=principal.account_id, action="IDEMPOTENCY_RESULT", target_type=operation.command,
                after_value={
                    "version": 1, "scope_digest": operation.scope_digest, "payload_digest": digest,
                    "result": result, "clinic_ids": sorted(clinic_ids),
                },
            )
    return success(result)


def appointment_board(principal, start, end, filters):
    scope = principal.clinic_scope(*BOARD)
    dentist_scope = principal.clinic_scope("DENTIST")
    own = principal.employee_id if dentist_scope else None
    params = [start, end, scope is None, list(scope or ()), own, list(dentist_scope)]
    query = """
        SELECT a.appointment_id, a.appointment_no, a.status, sc.clinic_id, sc.dentist_id,
               sc.start_at, sc.end_at, p.full_name
        FROM appointment a
        JOIN slot_claim sc ON a.claim_id = sc.claim_id
        JOIN patient p ON p.patient_id = sc.patient_id
        WHERE sc.end_at > %s AND sc.start_at < %s
          AND (%s OR sc.clinic_id = ANY(%s) OR (sc.dentist_id = %s AND sc.clinic_id = ANY(%s)))
    """
    if filters.get("clinic_id"):
        query += " AND sc.clinic_id = %s"
        params.append(filters["clinic_id"])
    if filters.get("dentist_id"):
        query += " AND sc.dentist_id = %s"
        params.append(filters["dentist_id"])
    if filters.get("status"):
        query += " AND a.status = %s"
        params.append(filters["status"])
    query += " ORDER BY sc.start_at, a.appointment_id"
    with connection.cursor() as cursor:
        cursor.execute(query, params)
        return [
            {
                "appointment_id": str(pk), "appointment_no": number, "status": status,
                "clinic_id": str(clinic), "dentist_id": str(doctor),
                "start_at": starts.isoformat(), "end_at": ends.isoformat(),
                **({"patient_display": patient} if (
                    principal.allows("FRONT_DESK", clinic) or (doctor == own and clinic in dentist_scope)
                ) else {}),
            }
            for pk, number, status, clinic, doctor, starts, ends, patient in cursor.fetchall()
        ]


@api_view(["GET"])
def board(request):
    require_any(request.user, *BOARD, "DENTIST")
    clinic_id = selected_clinic(request, (*BOARD, "DENTIST"))
    filters = values(BoardFilter, request.query_params)
    start = datetime.combine(filters["date_from"], time.min, BUSINESS_ZONE)
    end = datetime.combine(filters["date_to"] + timedelta(days=1), time.min, BUSINESS_ZONE)
    visible = visible_shifts(request.user, (MANAGER, SCHEDULER), published_for_front_desk=True)
    query = visible.filter(end_at__gt=start, start_at__lt=end)
    if filters.get("clinic_id"):
        query = query.filter(clinic_id=filters["clinic_id"])
    if filters.get("dentist_id"):
        query = query.filter(dentist_id=filters["dentist_id"])
    rows = query.order_by("start_at", "pk")
    extras = {}
    if filters.get("view") == "week":
        rows = list(rows.select_related("clinic", "dentist"))
        reasons = rejection_reasons(rows)
        items = [
            {
                **shift_data(row), "clinic_name": row.clinic.clinic_name, "dentist_name": row.dentist.full_name,
                **({"rejection_reason": reasons[row.pk]} if reasons.get(row.pk) else {}),
            }
            for row in rows
        ]
        extras["shortages"] = staffing_shortages(request.user, start, end, clinic_id)
        extras["conflicts"] = shift_conflicts(visible, rows, start, end)
    else:
        items = [shift_data(row) for row in rows]
    if filters.get("view") == "day" and clinic_id is not None:
        from adc.scheduling.day_capacity import unavailable_chair_periods

        extras["unavailable"] = unavailable_chair_periods(clinic_id, start, end)
    return success({
        "shifts": items, "appointments": appointment_board(request.user, start, end, filters), **extras,
    })


urlpatterns = [
    path("clinics", clinics),
    path("schedule/board", board),
    path("schedule/dentists", dentists),
    path("qualifications", qualifications),
    path("shift-demands", demands),
    path("shifts", shifts),
    path("shifts/batch", batch_shifts),
    path("shifts/<int:pk>", patch_shift),
    path("shifts/<int:pk>/submit", submit),
    path("shifts/<int:pk>/respond", respond),
    path("shifts/<int:pk>/publish", publish),
]
