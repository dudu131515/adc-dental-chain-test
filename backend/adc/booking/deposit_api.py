from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework.decorators import api_view

from adc.booking.deposit_service import request_simulation, retry_refund
from adc.booking.models import Appointment, DepositPayment, DepositRefund
from adc.common.http import success


def visible_payments(principal):
    query = DepositPayment.objects.select_related("claim")
    if principal.channel == "patient":
        return query.filter(claim__patient_id=principal.patient_id)
    principal.require("FRONT_DESK")
    scope = principal.clinic_scope("FRONT_DESK")
    return query.filter(
        Q(appointment__isnull=True, claim__clinic_id__in=scope)
        | Q(appointment__claim__clinic_id__in=scope)
    )


def refund_data(refund):
    return {
        "refund_id": str(refund.pk), "deposit_id": str(refund.deposit_id),
        "status": refund.status, "amount": format(refund.refund_amount, ".2f"),
    }


def payment_data(payment):
    appointment = Appointment.objects.filter(deposit=payment).first()
    refund = DepositRefund.objects.filter(deposit=payment).first()
    return {
        "deposit_id": str(payment.pk), "claim_id": str(payment.claim_id), "status": payment.client_status,
        "amount": format(payment.amount, ".2f"), "claim_status": payment.claim.status,
        "appointment_id": str(appointment.pk) if appointment else None,
        "appointment_no": appointment.appointment_no if appointment else None,
        "refund": refund_data(refund) if refund else None,
    }


@api_view(["GET"])
def deposit(request, pk):
    return success(payment_data(get_object_or_404(visible_payments(request.user), pk=pk)))


@api_view(["POST"])
def simulate(request, pk):
    source = get_object_or_404(visible_payments(request.user), pk=pk)
    request_simulation(source.pk, request.user.account_id)
    actual = get_object_or_404(visible_payments(request.user), pk=pk)
    return success(payment_data(actual), status_code=202 if actual.client_status == "PENDING" else 200)


@api_view(["GET"])
def refund(request, pk):
    entry = get_object_or_404(DepositRefund, pk=pk, deposit__in=visible_payments(request.user))
    return success(refund_data(entry))


@api_view(["POST"])
def retry(request, pk):
    request.user.require("FRONT_DESK")
    first = get_object_or_404(DepositRefund, pk=pk, deposit__in=visible_payments(request.user))
    retry_refund(first.pk, request.user.account_id)
    current = DepositRefund.objects.get(pk=first.pk)
    return success(refund_data(current), status_code=202 if current.status == "PENDING" else 200)


urlpatterns = [
    path("deposit-payments/<int:pk>", deposit),
    path("deposit-payments/<int:pk>/simulate", simulate),
    path("deposit-refunds/<int:pk>", refund),
    path("deposit-refunds/<int:pk>/retry", retry),
]
