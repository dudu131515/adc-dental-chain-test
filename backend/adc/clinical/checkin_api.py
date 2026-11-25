from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.appointment_query import accessible_appointments, appointment_projection
from adc.clinical.checkin_service import assign_chair, available_chairs, check_in, check_in_at
from adc.common.http import success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values


class CheckIn(serializers.Serializer):
    expected_claim_id = ID()
    identity_confirmed = serializers.BooleanField()


class AssignChair(serializers.Serializer):
    expected_claim_id = ID()
    chair_id = ID()


def front_booking(request, pk):
    request.user.require("FRONT_DESK")
    appointment = get_object_or_404(accessible_appointments(request.user), pk=pk)
    request.user.require("FRONT_DESK", appointment.claim.clinic_id)
    return appointment


@api_view(["POST"])
def check_in_endpoint(request, pk):
    booking = front_booking(request, pk)
    fields = values(CheckIn, request.data)
    operation = OperationKey.from_request(request, command="check_in", target={"appointment_id": pk})
    saved = check_in(request.user, booking, fields, operation)
    return success({**appointment_projection(request.user, saved), "check_in_at": check_in_at(saved)})


@api_view(["GET"])
def chairs(request, pk):
    booking = front_booking(request, pk)
    options = available_chairs(booking, timezone.now())
    return success({
        "items": [{"chair_id": str(chair.pk), "chair_no": chair.chair_no, "chair_kind": chair.chair_kind}
                  for chair in options],
        "next_cursor": None,
    })


@api_view(["POST"])
def assign(request, pk):
    booking = front_booking(request, pk)
    fields = values(AssignChair, request.data)
    operation = OperationKey.from_request(request, command="assign_chair", target={"appointment_id": pk})
    usage = assign_chair(request.user, booking, fields, operation)
    return success({
        "appointment_id": str(pk), "status": usage.appointment.status,
        "chair_id": str(usage.chair_id), "chair_no": usage.chair.chair_no, "assigned_at": usage.assigned_at.isoformat(),
    })


urlpatterns = [
    path("appointments/<int:pk>/check-in", check_in_endpoint),
    path("appointments/<int:pk>/chair-options", chairs),
    path("appointments/<int:pk>/assign-chair", assign),
]
