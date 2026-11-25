from django.db import transaction
from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.appointment_query import accessible_appointments
from adc.booking.hold_service import booking_subject, create_hold, hold_projection, list_available, scope_hold
from adc.booking.models import SlotClaim
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values


class Availability(serializers.Serializer):
    clinic_id = ID()
    date = serializers.DateField()
    treatment_type_id = ID()
    dentist_id = ID(required=False)
    estimated_minutes = serializers.IntegerField(min_value=1, max_value=2**31 - 1, required=False)
    estimate_evidence = serializers.CharField(required=False)
    appointment_id = ID(required=False)
    preferred_start_at = serializers.DateTimeField(required=False)


class Hold(serializers.Serializer):
    clinic_id = ID()
    patient_id = ID(required=False)
    dentist_id = ID()
    shift_id = ID()
    treatment_type_id = ID()
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()
    estimated_minutes = serializers.IntegerField(min_value=1, max_value=2**31 - 1, required=False)
    estimate_evidence = serializers.CharField(required=False)
    other_treatment_ids = serializers.ListField(child=ID(), required=False)
    special_requirement = serializers.CharField(required=False)

    def validate(self, data):
        if data["end_at"] <= data["start_at"]:
            raise serializers.ValidationError({"end_at": "结束时间须晚于开始时间。"})
        extra = data.get("other_treatment_ids", [])
        if len(extra) != len(set(extra)) or data["treatment_type_id"] in extra:
            raise serializers.ValidationError({"other_treatment_ids": "其他治疗意向不能包含重复项目或主项目。"})
        return data


class FindHold(serializers.Serializer):
    clinic_id = ID()
    patient_id = ID(required=False)


@api_view(["GET"])
def options(request):
    filters = values(Availability, request.query_params)
    previous = None
    if filters.get("appointment_id"):
        previous_record = get_object_or_404(accessible_appointments(request.user), pk=filters["appointment_id"])
        previous = previous_record.claim
        if previous_record.status not in {"CONFIRMED", "CHECKED_IN"} or previous_record.is_attended:
            raise ApiProblem(409, "INVALID_TRANSITION", "当前状态不能重新查询改期候选。")
    return success(list_available(
        request.user, filters["clinic_id"], filters["date"], filters["treatment_type_id"],
        filters.get("dentist_id"), filters.get("estimated_minutes"), filters.get("estimate_evidence"),
        previous=previous, preferred=filters.get("preferred_start_at"),
    ))


@api_view(["POST"])
def holds(request):
    data = values(Hold, request.data)
    data["patient_id"] = booking_subject(request.user, data["clinic_id"], data.get("patient_id"))
    operation = OperationKey.from_request(
        request, command="create_hold", target={"clinic_id": data["clinic_id"], "patient_id": data["patient_id"]},
    )
    record, now, created = create_hold(request.user, data, operation)
    return success(hold_projection(record, now), status_code=201 if created else 200)


@api_view(["GET"])
def by_action(request):
    filters = values(FindHold, request.query_params)
    patient_id = booking_subject(request.user, filters["clinic_id"], filters.get("patient_id"))
    operation = OperationKey.from_request(
        request, command="create_hold", target={"clinic_id": filters["clinic_id"], "patient_id": patient_id},
    )
    result_id = operation.result_id()
    if result_id is None:
        raise ApiProblem(404, "NOT_FOUND", "找不到同一动作已提交的占位。")
    return success(hold_projection(scope_hold(request, result_id), timezone.now()))


@api_view(["GET"])
def detail(request, pk):
    return success(hold_projection(scope_hold(request, pk), timezone.now()))


@api_view(["POST"])
def release(request, pk):
    scope_hold(request, pk)
    with transaction.atomic():
        hold = get_object_or_404(SlotClaim.objects.select_for_update(), pk=pk)
        now = timezone.now()
        if hold.status == "CONFIRMED":
            raise ApiProblem(409, "INVALID_TRANSITION", "正式预约请按预约变更流程办理。")
        if hold.status == "HOLD":
            hold.status = "EXPIRED" if hold.expires_at <= now else "RELEASED"
            hold.save(update_fields=("status",))
    return success(hold_projection(hold, now))


urlpatterns = [
    path("booking/options", options),
    path("holds", holds),
    path("holds/by-action", by_action),
    path("holds/<int:pk>", detail),
    path("holds/<int:pk>/release", release),
]
