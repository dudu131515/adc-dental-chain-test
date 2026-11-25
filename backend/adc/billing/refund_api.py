from decimal import Decimal

from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.billing.invoice_api import front_invoice
from adc.billing.invoice_service import invoice_data, needs_reconciliation, payment_data
from adc.billing.models import InvoicePayment
from adc.billing.refund_service import request_refund, retry_refund
from adc.common.http import success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values


class Refund(serializers.Serializer):
    source_payment_id = ID()
    adjustment_id = ID(required=False, allow_null=True)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0.01"))


def output(entry, invoice, principal, status):
    entry.refresh_from_db()
    invoice.refresh_from_db()
    payment = {**payment_data(entry), "reconciliation_required": needs_reconciliation(entry.pk)}
    return success({"payment": payment, "invoice": invoice_data(invoice, principal)}, status_code=status(entry))


@api_view(["POST"])
def refund(request, pk):
    invoice = front_invoice(request.user, pk)
    fields = values(Refund, request.data)
    operation = OperationKey.from_request(request, command="invoice_refund", target={"invoice_id": pk})
    entry, created = request_refund(request.user, invoice.pk, fields, operation)
    return output(entry, invoice, request.user, lambda row: 200 if not created else (202 if row.status == "PENDING" else 201))


@api_view(["POST"])
def retry(request, pk, payment_id):
    invoice = front_invoice(request.user, pk)
    entry = retry_refund(request.user, invoice.pk, payment_id)
    return output(entry, invoice, request.user, lambda row: 202 if row.status == "PENDING" else 200)


@api_view(["GET"])
def refund_by_action(request, pk):
    invoice = front_invoice(request.user, pk)
    operation = OperationKey.from_request(request, command="invoice_refund", target={"invoice_id": pk})
    entry = get_object_or_404(InvoicePayment, pk=operation.result_id(), invoice=invoice, payment_kind="REFUND")
    return output(entry, invoice, request.user, lambda row: 200)


urlpatterns = [
    path("invoices/<int:pk>/refunds/by-action", refund_by_action),
    path("invoices/<int:pk>/refunds", refund),
    path("invoices/<int:pk>/refunds/<int:payment_id>/retry", retry),
]
