from decimal import Decimal

from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.billing.invoice_service import create_payment, invoice_data, issue_invoice, payment_data
from adc.billing.models import Invoice, InvoicePayment, TreatmentCorrection
from adc.clinical.models import Visit
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import values


class Payment(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0.01"))


def manager_invoice_scope(principal):
    return Q(
        visit_id__in=TreatmentCorrection.objects.values("visit_id"),
        visit__appointment__claim__clinic_id__in=principal.clinic_scope("CLINIC_MANAGER"),
    )


def accessible_invoices(principal):
    if not any(principal.allows(role) for role in ("FRONT_DESK", "DENTIST", "CLINIC_MANAGER")):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能访问结算资料。")
    condition = Q(visit__appointment__claim__clinic_id__in=principal.clinic_scope("FRONT_DESK"))
    if principal.allows("DENTIST"):
        condition |= Q(visit__main_dentist_id=principal.employee_id, visit__appointment__claim__clinic_id__in=principal.clinic_scope("DENTIST"))
    if principal.allows("CLINIC_MANAGER"):
        condition |= manager_invoice_scope(principal)
    return Invoice.objects.select_related("visit__appointment__claim").filter(condition)


def front_visit(principal, pk):
    principal.require("FRONT_DESK")
    return get_object_or_404(
        Visit.objects.select_related("appointment__claim"),
        pk=pk, appointment__claim__clinic_id__in=principal.clinic_scope("FRONT_DESK"),
    )


def front_invoice(principal, pk):
    invoice = get_object_or_404(accessible_invoices(principal), pk=pk)
    principal.require("FRONT_DESK", invoice.visit.appointment.claim.clinic_id)
    return invoice


@api_view(["GET"])
def queue(request):
    request.user.require("FRONT_DESK")
    rows = Visit.objects.select_related("appointment__claim").filter(
        appointment__claim__clinic_id__in=request.user.clinic_scope("FRONT_DESK"),
        status__in=("COMPLETED", "TERMINATED"),
    ).order_by("-ended_at", "-pk")
    items = []
    for row in rows:
        invoice = Invoice.objects.filter(visit=row).first()
        items.append({
            "visit_id": str(row.pk), "appointment_no": row.appointment.appointment_no,
            "clinic_id": str(row.appointment.claim.clinic_id), "ended_at": row.ended_at.isoformat(),
            "status": row.status, "invoice_id": str(invoice.pk) if invoice else None,
            "invoice_no": invoice.invoice_no if invoice else None,
        })
    return success({"items": items, "next_cursor": None})


@api_view(["POST"])
def issue(request, pk):
    visit = front_visit(request.user, pk)
    operation = OperationKey.from_request(request, command="issue_invoice", target={"visit_id": pk})
    invoice, created = issue_invoice(request.user, visit, operation)
    return success(invoice_data(invoice, request.user), status_code=201 if created else 200)


@api_view(["GET"])
def detail(request, pk):
    invoice = get_object_or_404(accessible_invoices(request.user), pk=pk)
    return success(invoice_data(invoice, request.user))


@api_view(["POST"])
def collect(request, pk):
    invoice = front_invoice(request.user, pk)
    amount = values(Payment, request.data)["amount"]
    operation = OperationKey.from_request(request, command="invoice_payment", target={"invoice_id": pk})
    entry, created = create_payment(request.user, invoice, amount, operation)
    entry.refresh_from_db()
    invoice.refresh_from_db()
    status = 200 if not created else (202 if entry.status == "PENDING" else 201)
    return success({"payment": payment_data(entry), "invoice": invoice_data(invoice, request.user)}, status_code=status)


@api_view(["GET"])
def payment(request, pk, payment_id):
    invoice = get_object_or_404(accessible_invoices(request.user), pk=pk)
    clinic = invoice.visit.appointment.claim.clinic_id
    if not request.user.allows("FRONT_DESK", clinic) and not Invoice.objects.filter(
        manager_invoice_scope(request.user), pk=invoice.pk,
    ).exists():
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能回查收退流水。")
    entry = get_object_or_404(InvoicePayment, pk=payment_id, invoice=invoice)
    return success(payment_data(entry))


@api_view(["GET"])
def payment_by_action(request, pk):
    invoice = front_invoice(request.user, pk)
    operation = OperationKey.from_request(request, command="invoice_payment", target={"invoice_id": pk})
    pk = operation.result_id()
    if not pk:
        raise ApiProblem(404, "NOT_FOUND", "未找到该动作已提交的收款记录。")
    entry = get_object_or_404(InvoicePayment, pk=pk, invoice=invoice)
    return success({"payment": payment_data(entry), "invoice": invoice_data(invoice, request.user)})


urlpatterns = [
    path("billing/queue", queue),
    path("visits/<int:pk>/invoice", issue),
    path("invoices/<int:pk>", detail),
    path("invoices/<int:pk>/payments", collect),
    path("invoices/<int:pk>/payments/by-action", payment_by_action),
    path("invoices/<int:pk>/payments/<int:payment_id>", payment),
]
