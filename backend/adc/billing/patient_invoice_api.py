from datetime import datetime

from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.billing.invoice_service import amount_data, balance
from adc.billing.models import Invoice, InvoiceAdjustment, InvoiceLine, InvoicePayment
from adc.common.http import ApiProblem, cursor_position, scoped_cursor, success
from adc.common.serializers import ID, values
from adc.reporting.fact_queries import consistent_read, rows
from adc.reporting.period_locks import BUSINESS_ZONE


class InvoiceQuery(serializers.Serializer):
    appointment_id = ID(required=False)
    limit = serializers.IntegerField(min_value=1, max_value=50, default=20)
    cursor = serializers.CharField(max_length=4096, required=False)


def patient_invoices(principal):
    if principal.channel != "patient" or principal.patient_id is None:
        raise ApiProblem(403, "PERMISSION_DENIED", "请使用患者本人会话查询诊疗费用单。")
    return Invoice.objects.filter(visit__appointment__claim__patient_id=principal.patient_id).select_related(
        "visit__appointment__claim__clinic",
    ).only("invoice_no", "status", "original_total", "issued_at", "visit__started_at", "visit__appointment__claim__clinic__clinic_name")


def summary(invoice, totals):
    visit = invoice.visit
    booking = visit.appointment
    clinic = booking.claim.clinic
    return {
        "invoice_id": str(invoice.pk), "invoice_no": invoice.invoice_no, "status": invoice.status,
        "visit_date": visit.started_at.astimezone(BUSINESS_ZONE).date().isoformat(),
        "clinic": {"clinic_id": str(clinic.pk), "name": clinic.clinic_name},
        "accrued": amount_data(totals["accrued"]), "outstanding": amount_data(totals["outstanding"]),
    }


@api_view(["GET"])
def invoice_list(request):
    query = patient_invoices(request.user)
    filters = values(InvoiceQuery, request.query_params)
    appointment_id = filters.get("appointment_id")
    binding = {
        "list": "patient_invoices", "account": request.user.account_id, "patient": request.user.patient_id,
        "appointment": appointment_id,
    }
    if appointment_id is not None:
        query = query.filter(visit__appointment_id=appointment_id)
    if "cursor" in filters:
        occurred, key = cursor_position(filters["cursor"], binding)
        issued_at = datetime.fromisoformat(occurred)
        query = query.filter(Q(issued_at__lt=issued_at) | Q(issued_at=issued_at, pk__lt=key))

    limit = filters["limit"]
    with consistent_read():
        page = list(query.order_by("-issued_at", "-pk")[:limit + 1])
        items = page[:limit]
        totals = {
            row["invoice_id"]: row for row in rows(
                """
                SELECT invoice_id, accrued_amount AS accrued, outstanding_amount AS outstanding
                FROM invoice_reporting_fact WHERE invoice_id = ANY(%s)
                """,
                [[invoice.pk for invoice in items]],
            )
        } if items else {}
        result = [summary(invoice, totals[invoice.pk]) for invoice in items]

    next_cursor = scoped_cursor(binding, [items[-1].issued_at.isoformat(), items[-1].pk]) if len(page) > limit else None
    return success({"items": result, "next_cursor": next_cursor})


@api_view(["GET"])
def invoice_detail(request, pk):
    with consistent_read():
        invoice = get_object_or_404(patient_invoices(request.user), pk=pk)
        totals = balance(invoice)
        adjustments = InvoiceAdjustment.objects.filter(
            invoice=invoice, correction__status="APPLIED", correction__correctionapproval__decision="APPROVED",
        ).order_by("pk")
        funds = InvoicePayment.objects.filter(invoice=invoice).filter(
            Q(status="SUCCEEDED") | Q(status="PENDING", payment_kind="REFUND"),
        ).order_by("pk")
        data = {
            **summary(invoice, totals),
            "original_total": amount_data(invoice.original_total),
            **{key: amount_data(totals[key]) for key in ("received", "refunded", "pending_refund")},
            "lines": [
                {
                    "treatment_name": line.treatment_name_snapshot, "unit": line.unit_name_snapshot,
                    "units": format(line.units, ".3f"), "unit_price": amount_data(line.unit_price),
                    "subtotal": amount_data(line.subtotal),
                }
                for line in InvoiceLine.objects.filter(invoice=invoice).order_by("pk")
            ],
            "adjustments": [{"signed_amount": amount_data(row.signed_amount)} for row in adjustments],
            "funds": [
                {
                    "kind": row.payment_kind, "status": row.status, "amount": amount_data(row.amount),
                    "receipt_at": row.paid_at.astimezone(BUSINESS_ZONE).isoformat() if row.paid_at else None,
                }
                for row in funds
            ],
        }
    return success(data)


urlpatterns = [
    path("patients/me/invoices", invoice_list),
    path("patients/me/invoices/<int:pk>", invoice_detail),
]
