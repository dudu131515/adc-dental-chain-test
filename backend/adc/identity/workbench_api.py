from datetime import date, datetime, time, timedelta

from django.db.models import Q
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.billing.models import InvoicePayment, TreatmentCorrection
from adc.booking.models import Appointment, DepositPayment, DepositRefund
from adc.clinical.models import Visit
from adc.common.http import ApiProblem, success
from adc.common.serializers import ID, values
from adc.identity.permissions import HQ_ROLES, LOCAL_ROLES
from adc.reporting.period_locks import BUSINESS_ZONE


class AlertQuery(serializers.Serializer):
    clinic_id = ID(required=False)
    date = serializers.DateField(required=False)

    def validate_date(self, value):
        if value == date.max:
            raise serializers.ValidationError("请选择有效的业务日期。")
        return value


def scope_for(principal, role, clinic_id):
    clinics = principal.clinic_scope(role)
    if clinic_id is not None:
        return [clinic_id] if clinic_id in clinics else []
    return clinics


def schedule_alert(clinics, day, now):
    bookings = Appointment.objects.filter(claim__clinic_id__in=clinics)
    if day:
        start = datetime.combine(day, time.min, BUSINESS_ZONE)
        bookings = bookings.filter(claim__start_at__gte=start, claim__start_at__lt=start + timedelta(days=1))
    return bookings.filter(
        Q(status="CHECKED_IN") | Q(status="CONFIRMED", claim__end_at__lte=now),
    ).exists()


def billing_alert(clinics):
    if not clinics:
        return False
    pending_invoices = InvoicePayment.objects.filter(
        invoice__visit__appointment__claim__clinic_id__in=clinics, status="PENDING",
    )
    completed = Visit.objects.filter(
        appointment__claim__clinic_id__in=clinics, status__in=("COMPLETED", "TERMINATED"), invoice__isnull=True,
    )
    return completed.exists() or pending_invoices.exists()


def reconciliation_alert(clinics):
    deposits = DepositPayment.objects.filter(claim__clinic_id__in=clinics)
    return (
        deposits.filter(status="PENDING", payment_token__isnull=False).exclude(payment_token="").exists()
        or DepositRefund.objects.filter(deposit__in=deposits, status__in=("PENDING", "FAILED")).exists()
    )


@api_view(["GET"])
def alerts(request):
    principal = request.user
    if principal.channel != "staff":
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能访问员工工作台。")
    query = values(AlertQuery, request.query_params)
    clinic_id = query.get("clinic_id")
    authorized = principal.clinic_scope(*(LOCAL_ROLES | HQ_ROLES))
    if clinic_id is not None and authorized is not None and clinic_id not in authorized:
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能访问该门店的工作台。")
    fronts = scope_for(principal, "FRONT_DESK", clinic_id)
    dentists = scope_for(principal, "DENTIST", clinic_id)
    managers = scope_for(principal, "CLINIC_MANAGER", clinic_id)
    return success({
        "schedule": schedule_alert(fronts, query.get("date"), timezone.now()),
        "clinical": Appointment.objects.filter(
            claim__clinic_id__in=dentists, claim__dentist_id=principal.employee_id,
            status__in=("CHECKED_IN", "IN_TREATMENT"),
        ).exists(),
        "billing": billing_alert(fronts),
        "reconciliation": reconciliation_alert(fronts),
        "corrections": TreatmentCorrection.objects.filter(
            visit__appointment__claim__clinic_id__in=managers, status="PENDING",
        ).exclude(requested_by_id=principal.employee_id).exists(),
    })


urlpatterns = [path("workbench/alerts", alerts)]
