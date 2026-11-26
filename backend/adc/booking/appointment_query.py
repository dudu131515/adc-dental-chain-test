from datetime import datetime, time, timedelta

from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.calendar import change_cutoff
from adc.booking.models import Appointment, DepositRefund
from adc.common.http import ApiProblem, success
from adc.common.serializers import ID, values
from adc.reporting.period_locks import BUSINESS_ZONE


BOOKING_STAFF = ("FRONT_DESK", "CLINIC_MANAGER", "HQ_SCHEDULER")


class AppointmentFilters(serializers.Serializer):
    clinic_id = ID(required=False)
    dentist_id = ID(required=False)
    date = serializers.DateField(required=False)
    status = serializers.ChoiceField(choices=(
        "CONFIRMED", "CHECKED_IN", "IN_TREATMENT", "COMPLETED", "CANCELLED", "NO_SHOW",
    ), required=False)


def accessible_appointments(principal):
    query = Appointment.objects.select_related(
        "claim__clinic", "claim__patient", "claim__dentist", "claim__requested_treatment_type", "deposit",
    )
    if principal.channel == "patient":
        return query.filter(claim__patient_id=principal.patient_id)
    if not any(principal.allows(role) for role in (*BOOKING_STAFF, "DENTIST")):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能访问预约资料。")
    scope = principal.clinic_scope(*BOOKING_STAFF)
    if scope is None:
        return query
    condition = Q(claim__clinic_id__in=scope)
    if principal.allows("DENTIST"):
        condition |= Q(claim__dentist_id=principal.employee_id, claim__clinic_id__in=principal.clinic_scope("DENTIST"))
    return query.filter(condition)


def allowed_actions(principal, appointment, now, deadline):
    clinic = appointment.claim.clinic_id
    can_self_manage = principal.channel == "patient" or principal.allows("FRONT_DESK", clinic)
    can_coordinate = any(principal.allows(role, clinic) for role in BOOKING_STAFF)
    state = appointment.status
    if state == "CONFIRMED" and can_self_manage:
        actions = []
        if deadline and now <= deadline:
            actions.append("reschedule")
        if now < appointment.claim.start_at:
            actions.append("cancel")
        else:
            actions.append("contact_clinic")
        if principal.allows("FRONT_DESK", clinic):
            actions.append("check_in")
            if now >= appointment.claim.end_at:
                actions.append("review_no_show")
        if can_coordinate:
            actions.append("coordinate")
            if now >= appointment.claim.start_at:
                actions.append("cancellation_review")
        return actions
    if state == "CHECKED_IN":
        if can_coordinate:
            return ["cancellation_review", "coordinate"]
        return ["contact_clinic"] if principal.channel == "patient" else []
    if state == "CONFIRMED" and can_coordinate:
        return ["coordinate"] + (["cancellation_review"] if now >= appointment.claim.start_at else [])
    return []


def appointment_projection(principal, appointment, *, as_of=None):
    claim, deposit = appointment.claim, appointment.deposit
    now = as_of or timezone.now()
    deadline, calendar_issue = None, None
    if appointment.status in {"CONFIRMED", "CHECKED_IN"}:
        try:
            deadline, _ = change_cutoff(claim.clinic_id, claim.start_at)
        except ApiProblem as issue:
            calendar_issue = issue.code
    refund = DepositRefund.objects.filter(deposit=deposit).order_by("-pk").first()
    response = {
        "appointment_id": str(appointment.pk), "appointment_no": appointment.appointment_no,
        "claim_id": str(claim.pk), "status": appointment.status, "is_attended": appointment.is_attended,
        "clinic": {"clinic_id": str(claim.clinic_id), "name": claim.clinic.clinic_name,
                   "address": claim.clinic.postal_address, "phone": claim.clinic.phone},
        "dentist": {"dentist_id": str(claim.dentist_id), "name": claim.dentist.full_name},
        "treatment": {"treatment_type_id": str(claim.requested_treatment_type_id), "name": claim.requested_treatment_type.treatment_name},
        "start_at": claim.start_at.isoformat(), "end_at": claim.end_at.isoformat(),
        "change_deadline_at": deadline.isoformat() if deadline else None,
        "calendar_issue": calendar_issue,
        "allowed_actions": allowed_actions(principal, appointment, now, deadline),
    }
    if (
        principal.channel == "patient" or principal.allows("FRONT_DESK", claim.clinic_id)
        or (principal.allows("DENTIST", claim.clinic_id) and principal.employee_id == claim.dentist_id)
    ):
        response["patient_display"] = {"patient_id": str(claim.patient_id), "name": claim.patient.full_name}
    if principal.channel == "patient" or principal.allows("FRONT_DESK", claim.clinic_id):
        response["deposit"] = {"deposit_id": str(deposit.pk), "amount": format(deposit.amount, ".2f"), "status": deposit.status}
        response["refund"] = (
            {"refund_id": str(refund.pk), "amount": format(refund.refund_amount, ".2f"), "status": refund.status}
            if refund else None
        )
    if principal.allows("FRONT_DESK", claim.clinic_id) or (
        principal.allows("DENTIST", claim.clinic_id) and principal.employee_id == claim.dentist_id
    ):
        from adc.clinical.models import ChairUsage, Visit
        usage = ChairUsage.objects.filter(appointment=appointment, released_at__isnull=True).select_related("chair").first()
        visit_id = Visit.objects.filter(appointment=appointment).values_list("pk", flat=True).first()
        response["chair"] = {"chair_id": str(usage.chair_id), "chair_no": usage.chair.chair_no} if usage else None
        response["visit_id"] = str(visit_id) if visit_id else None
    return response


@api_view(["GET"])
def appointments(request):
    filters = values(AppointmentFilters, request.query_params)
    day = filters.pop("date", None)
    query = accessible_appointments(request.user)
    if "clinic_id" in filters:
        if request.user.channel == "staff" and not any(
            request.user.allows(role, filters["clinic_id"]) for role in (*BOOKING_STAFF, "DENTIST")
        ):
            raise ApiProblem(404, "NOT_FOUND", "找不到可访问的门店。")
        query = query.filter(claim__clinic_id=filters["clinic_id"])
    if "dentist_id" in filters:
        query = query.filter(claim__dentist_id=filters["dentist_id"])
    if "status" in filters:
        query = query.filter(status=filters["status"])
    if day:
        start = datetime.combine(day, time.min, BUSINESS_ZONE)
        query = query.filter(claim__start_at__gte=start, claim__start_at__lt=start + timedelta(days=1))
    now = timezone.now()
    return success({
        "items": [appointment_projection(request.user, row, as_of=now) for row in query.order_by("claim__start_at", "pk")],
        "next_cursor": None,
    })


@api_view(["GET"])
def appointment(request, pk):
    record = get_object_or_404(accessible_appointments(request.user), pk=pk)
    return success(appointment_projection(request.user, record))


urlpatterns = [
    path("appointments", appointments),
    path("appointments/<int:pk>", appointment),
]
