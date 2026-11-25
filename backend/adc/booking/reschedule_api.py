from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.appointment_query import BOOKING_STAFF, accessible_appointments, appointment_projection
from adc.booking.models import AppointmentChange, DepositRefund
from adc.booking.reschedule_service import record_coordination, reschedule
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values


class Reschedule(serializers.Serializer):
    expected_claim_id = ID()
    clinic_id = ID()
    dentist_id = ID()
    shift_id = ID()
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()
    cause = serializers.ChoiceField(choices=("PATIENT", "CLINIC"), default="PATIENT")
    reason = serializers.CharField()
    patient_consent_ref = serializers.CharField(required=False)

    def validate(self, data):
        if data["end_at"] <= data["start_at"]:
            raise serializers.ValidationError({"end_at": "目标结束时间须晚于开始时间。"})
        return data


class Coordination(serializers.Serializer):
    expected_claim_id = ID()
    impact = serializers.CharField()
    patient_intent = serializers.CharField()


@api_view(["POST"])
def change(request, pk):
    current = get_object_or_404(accessible_appointments(request.user), pk=pk)
    fields = values(Reschedule, request.data)
    operation = OperationKey.from_request(request, command="reschedule", target={"appointment_id": pk})
    saved = reschedule(request.user, current, fields, operation)
    return success(appointment_projection(request.user, saved))


@api_view(["POST"])
def coordination(request, pk):
    current = get_object_or_404(accessible_appointments(request.user), pk=pk)
    fields = values(Coordination, request.data)
    operation = OperationKey.from_request(request, command="coordination_intent", target={"appointment_id": pk})
    return success({"evidence_id": str(record_coordination(request.user, current, fields, operation))})


@api_view(["GET"])
def handover(request, pk):
    principal = request.user
    if not any(principal.allows(role) for role in BOOKING_STAFF):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能回查门店交接证据。")
    allowed = principal.clinic_scope(*BOOKING_STAFF)
    matching = AppointmentChange.objects.filter(
        appointment_id=pk, change_type="RESCHEDULE", old_claim__isnull=False,
    ).select_related("old_claim", "appointment__deposit__claim")
    if allowed is not None:
        matching = matching.filter(old_claim__clinic_id__in=allowed)
    items = []
    for row in matching.order_by("changed_at", "pk"):
        old = row.old_claim
        deposit = row.appointment.deposit
        event = {
            "appointment_no": row.appointment.appointment_no, "origin_clinic_id": str(old.clinic_id),
            "old_start_at": old.start_at.isoformat(), "old_end_at": old.end_at.isoformat(),
            "changed_at": row.changed_at.isoformat(), "reason": row.reason,
        }
        if old.clinic_id == deposit.claim.clinic_id:
            refund = DepositRefund.objects.filter(deposit=deposit, requested_at__lte=row.changed_at).first()
            event["deposit"] = {"deposit_id": str(deposit.pk), "amount": format(deposit.amount, ".2f"), "status": deposit.status}
            if refund:
                status = "SUCCEEDED" if refund.completed_at and refund.completed_at <= row.changed_at else "PENDING"
                event["refund"] = {"amount": format(refund.refund_amount, ".2f"), "status": status}
        items.append(event)
    if not items:
        raise ApiProblem(404, "NOT_FOUND", "找不到可访问的原店交接证据。")
    return success({"items": items, "next_cursor": None})


urlpatterns = [
    path("appointments/<int:pk>/reschedule", change),
    path("appointments/<int:pk>/coordination-intents", coordination),
    path("appointments/<int:pk>/handover-evidence", handover),
]
