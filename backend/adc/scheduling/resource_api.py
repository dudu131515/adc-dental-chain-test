from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.hold_service import list_available
from adc.booking.models import SlotClaim
from adc.common.http import ApiProblem, success
from adc.common.serializers import values
from adc.identity.models import Clinic
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.api import MANAGER, SCHEDULER, require_any, scheduler_object, scoped, shift_data
from adc.scheduling.models import DentalChair, Shift
from adc.scheduling.resource_service import active_appointments, stop_chair, withdraw_shift


class Reason(serializers.Serializer):
    reason = serializers.CharField()


class Downtime(Reason):
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()


def downtime_data(entry, *, include_reason):
    result = {
        "unavailability_id": str(entry.pk), "chair_id": str(entry.chair_id),
        "start_at": entry.start_at.isoformat(), "end_at": entry.end_at.isoformat(),
    }
    if include_reason:
        result["reason"] = entry.reason
    return result


@api_view(["GET"])
def chairs(request, pk):
    roles = ("FRONT_DESK", MANAGER, SCHEDULER)
    require_any(request.user, *roles)
    if not any(request.user.allows(role, pk) for role in roles):
        raise ApiProblem(404, "NOT_FOUND", "找不到可访问的门店。")
    get_object_or_404(Clinic, pk=pk)
    show_reason = request.user.allows(MANAGER, pk) or request.user.allows(SCHEDULER, pk)
    results = DentalChair.objects.filter(clinic_id=pk).prefetch_related("dentalchairunavailability_set")
    return success({
        "items": [
            {
                "chair_id": str(row.pk), "chair_no": row.chair_no, "chair_kind": row.chair_kind, "status": row.status,
                "unavailability": [downtime_data(item, include_reason=show_reason)
                                   for item in row.dentalchairunavailability_set.all()],
            }
            for row in results.order_by("chair_no")
        ],
        "next_cursor": None,
    })


@api_view(["POST"])
def chair_stop(request, pk):
    request.user.require(MANAGER)
    chair = get_object_or_404(scoped(DentalChair.objects.all(), request.user.clinic_scope(MANAGER)), pk=pk)
    entry, impacted = stop_chair(request.user, chair, **values(Downtime, request.data))
    return success({
        **downtime_data(entry, include_reason=True),
        "appointments_to_review": impacted,
    }, status_code=201)


@api_view(["GET"])
def affected(request, pk):
    require_any(request.user, MANAGER, SCHEDULER)
    shift = get_object_or_404(scoped(Shift.objects.all(), request.user.clinic_scope(MANAGER, SCHEDULER)), pk=pk)
    items = active_appointments(shift_id=pk)
    sources = SlotClaim.objects.select_related("requested_treatment_type").in_bulk(int(row["claim_id"]) for row in items)
    for item in items:
        source = sources[int(item["claim_id"])]
        day = source.start_at.astimezone(BUSINESS_ZONE).date()
        item["same_clinic_options"] = list_available(
            request.user, shift.clinic_id, day, source.requested_treatment_type_id,
            previous=source, exclude_shift_id=pk,
        )["items"]
    return success({"items": items, "next_cursor": None})


@api_view(["POST"])
def withdraw(request, pk):
    first = scheduler_object(request, pk)
    reason = values(Reason, request.data)["reason"]
    return success(shift_data(withdraw_shift(request.user, first, reason)))


urlpatterns = [
    path("clinics/<int:pk>/chairs", chairs),
    path("chairs/<int:pk>/unavailability", chair_stop),
    path("shifts/<int:pk>/affected-appointments", affected),
    path("shifts/<int:pk>/withdraw", withdraw),
]
