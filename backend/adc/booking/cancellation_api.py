from decimal import Decimal

from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.appointment_query import accessible_appointments, appointment_projection
from adc.booking.cancellation_service import cancellation_quote, operate
from adc.common.http import success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values


class Quote(serializers.Serializer):
    cause = serializers.ChoiceField(choices=("PATIENT", "CLINIC"), default="PATIENT")


class AppointmentAction(serializers.Serializer):
    expected_claim_id = ID()
    reason = serializers.CharField()


class Cancel(AppointmentAction, Quote):
    quoted_refund_amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal(0))
    coordination_evidence = serializers.CharField(required=False)


class Review(AppointmentAction):
    conclusion = serializers.ChoiceField(choices=("CONTINUE", "PATIENT_CANCEL", "CLINIC_CANCEL"))
    coordination_evidence = serializers.CharField(required=False)


class NoShow(AppointmentAction):
    patient_absent = serializers.BooleanField()
    clinic_able = serializers.BooleanField()


@api_view(["GET"])
def quote(request, pk):
    appointment = get_object_or_404(accessible_appointments(request.user), pk=pk)
    cause = values(Quote, request.query_params)["cause"]
    amount = cancellation_quote(request.user, appointment, cause)
    return success({
        "appointment_id": str(pk), "expected_claim_id": str(appointment.claim_id),
        "refund_amount": format(amount, ".2f"), "cause": cause,
    })


def apply_action(request, pk, serializer, command, mode):
    first = get_object_or_404(accessible_appointments(request.user), pk=pk)
    fields = values(serializer, request.data)
    operation = OperationKey.from_request(request, command=command, target={"appointment_id": pk})
    changed = operate(request.user, first, fields, operation, mode=mode)
    return success(appointment_projection(request.user, changed))


@api_view(["POST"])
def cancel(request, pk):
    return apply_action(request, pk, Cancel, "cancel", "ordinary")


@api_view(["POST"])
def review(request, pk):
    return apply_action(request, pk, Review, "cancellation_review", "review")


@api_view(["POST"])
def no_show(request, pk):
    return apply_action(request, pk, NoShow, "no_show", "no_show")


urlpatterns = [
    path("appointments/<int:pk>/cancellation-quote", quote),
    path("appointments/<int:pk>/cancel", cancel),
    path("appointments/<int:pk>/cancellation-review", review),
    path("appointments/<int:pk>/no-show", no_show),
]
