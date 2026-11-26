from datetime import date, datetime, time, timedelta
from decimal import Decimal

from django.db import connection
from django.db.models import Exists, F, OuterRef, Q, Subquery, Value
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.billing.invoice_service import ZERO, amount_data
from adc.billing.models import Invoice, InvoicePayment
from adc.booking.models import AppointmentChange, DepositPayment, DepositRefund
from adc.common.http import ApiProblem, success
from adc.common.serializers import ID, values
from adc.identity.models import AuditLog, Clinic
from adc.reporting.fact_queries import consistent_read, rows
from adc.reporting.period_locks import BUSINESS_ZONE


TOTAL_KEYS = {
    "DEPOSIT_PAYMENT": "deposit_received",
    "DEPOSIT_REFUND": "deposit_refunded",
    "TREATMENT_PAYMENT": "treatment_received",
    "TREATMENT_REFUND": "treatment_refunded",
}
DEPOSIT_REASONS = {"PATIENT_CANCELLATION", "CLINIC_CANCELLATION", "NO_SHOW", "UNCONFIRMED_APPOINTMENT", "VISIT_STARTED"}


class ReconciliationQuery(serializers.Serializer):
    clinic_id = ID()
    date = serializers.DateField()

    def validate_date(self, day):
        if day == date.max:
            raise serializers.ValidationError("请选择有效的营业日期。")
        return day


def local_timestamp(timestamp):
    return timestamp.astimezone(BUSINESS_ZONE).isoformat() if timestamp else None


def initial_request(target_type, *actions):
    return Subquery(
        AuditLog.objects.filter(target_type=target_type, target_id=OuterRef("pk"), action__in=actions)
        .order_by("occurred_at", "pk").values("occurred_at")[:1]
    )


def fund(kind, row, clinic_id, cutoff, requested_at, receipt_at, **evidence):
    request_day = requested_at.astimezone(BUSINESS_ZONE).date() if requested_at else None
    return {
        "id": str(row.pk), "kind": kind, "clinic_id": str(clinic_id), "status": row.status,
        "requested_at": local_timestamp(requested_at), "receipt_at": local_timestamp(receipt_at),
        "cross_day": request_day < cutoff.astimezone(BUSINESS_ZONE).date() if request_day else None,
        "reason": None, "retained_amount": None, "source": None, **evidence,
    }


def deposit_source(appointment_id, appointment_clinic, clinic_id, can_read_handover):
    if appointment_id is None:
        return None
    if appointment_clinic == clinic_id:
        return {"kind": "appointment", "id": str(appointment_id)}
    if can_read_handover:
        return {"kind": "handover", "id": str(appointment_id)}
    return None


def deposit_funds(clinic_id, start, end, cutoff):
    payments = DepositPayment.objects.filter(claim__clinic_id=clinic_id).annotate(
        first_request=initial_request("deposit_payment", "DEPOSIT_SIMULATION_REQUESTED"),
        handover=Exists(AppointmentChange.objects.filter(
            appointment_id=OuterRef("appointment__pk"), change_type="RESCHEDULE", old_claim__clinic_id=clinic_id,
        )),
        appointment_id=F("appointment__pk"),
        appointment_clinic=F("appointment__claim__clinic_id"),
    ).only("claim", "amount", "status", "paid_at")
    received = Q(status="PAID", paid_at__gte=start, paid_at__lt=end, paid_at__lte=cutoff)
    pending = Q(status="PENDING", payment_token__isnull=False) & ~Q(payment_token="") & (
        Q(first_request__lte=cutoff) | Q(first_request__isnull=True)
    )
    for row in payments.filter(received | pending):
        source = deposit_source(row.appointment_id, row.appointment_clinic, clinic_id, row.handover)
        yield fund(
            "DEPOSIT_PAYMENT", row, clinic_id, cutoff, row.first_request, row.paid_at if row.status == "PAID" else None,
            amount=amount_data(row.amount), claim_id=str(row.claim_id), source=source,
        )

    refunds = DepositRefund.objects.filter(deposit__claim__clinic_id=clinic_id).annotate(
        handover=Exists(AppointmentChange.objects.filter(
            appointment_id=OuterRef("deposit__appointment__pk"), change_type="RESCHEDULE",
            old_claim__clinic_id=clinic_id,
        )),
        appointment_id=F("deposit__appointment__pk"),
        appointment_clinic=F("deposit__appointment__claim__clinic_id"),
        original_claim_id=F("deposit__claim_id"),
        original_amount=F("deposit__amount"),
    ).only("deposit", "refund_amount", "reason", "status", "requested_at", "completed_at")
    paid_refund = Q(status="SUCCEEDED", completed_at__gte=start, completed_at__lt=end, completed_at__lte=cutoff)
    pending_refund = Q(status="PENDING", requested_at__lte=cutoff)
    retained = Q(status="RETAINED", requested_at__gte=start, requested_at__lt=end, requested_at__lte=cutoff)
    failed = Q(status="FAILED", refund_amount__gt=ZERO, requested_at__lte=cutoff, deposit__status="PAID")
    for row in refunds.filter(paid_refund | pending_refund | retained | failed):
        source = deposit_source(row.appointment_id, row.appointment_clinic, clinic_id, row.handover)
        reason = row.reason if row.reason in DEPOSIT_REASONS else None
        retained_amount = row.original_amount - row.refund_amount if row.original_amount > row.refund_amount else None
        yield fund(
            "DEPOSIT_REFUND", row, clinic_id, cutoff, row.requested_at,
            row.completed_at if row.status == "SUCCEEDED" else None,
            amount=amount_data(row.refund_amount), claim_id=str(row.original_claim_id), deposit_id=str(row.deposit_id),
            reason=reason, retained_amount=amount_data(retained_amount) if retained_amount is not None else None,
            source=source,
        )


def treatment_source(invoice_id, payment_id, front):
    if front:
        return {"kind": "invoice", "id": str(invoice_id)}
    if payment_id is not None:
        return {"kind": "payment", "invoice_id": str(invoice_id), "id": str(payment_id)}
    return None


def treatment_funds(principal, clinic_id, start, end, cutoff):
    from adc.billing.invoice_api import manager_invoice_scope

    front = principal.allows("FRONT_DESK", clinic_id)
    manager_sources = Invoice.objects.filter(manager_invoice_scope(principal), pk=OuterRef("invoice_id"))
    payments = InvoicePayment.objects.filter(invoice__visit__appointment__claim__clinic_id=clinic_id).annotate(
        first_request=initial_request("invoice_payment", "INVOICE_PAYMENT_RECORDED", "INVOICE_REFUND_RECORDED"),
        can_open_payment=Value(True) if front else Exists(manager_sources),
        source_invoice_id=F("source_payment__invoice_id"),
    ).only("invoice", "payment_kind", "amount", "status", "paid_at", "source_payment")
    succeeded = Q(status="SUCCEEDED", paid_at__gte=start, paid_at__lt=end, paid_at__lte=cutoff)
    pending = Q(status="PENDING") & (Q(first_request__lte=cutoff) | Q(first_request__isnull=True))
    for row in payments.filter(succeeded | pending):
        evidence = {}
        if row.can_open_payment:
            evidence["source"] = treatment_source(row.invoice_id, row.pk, front)
            if row.source_invoice_id == row.invoice_id:
                evidence["source_payment_id"] = str(row.source_payment_id)
        kind = "TREATMENT_PAYMENT" if row.payment_kind == "PAYMENT" else "TREATMENT_REFUND"
        yield fund(
            kind, row, clinic_id, cutoff, row.first_request, row.paid_at if row.status == "SUCCEEDED" else None,
            amount=amount_data(row.amount), **evidence,
        )


def treatment_refunds_due(principal, clinic_id):
    from adc.billing.invoice_api import manager_invoice_scope

    balances = rows(
        """
        SELECT f.invoice_id, f.refund_due - COALESCE(pending.amount, 0) AS amount
        FROM invoice_reporting_fact f
        JOIN visit v ON v.visit_id = f.visit_id
        JOIN appointment a ON a.appointment_id = v.appointment_id
        JOIN slot_claim claim ON claim.claim_id = a.claim_id
        LEFT JOIN LATERAL (
            SELECT SUM(amount) AS amount
            FROM invoice_payment p
            WHERE p.invoice_id = f.invoice_id AND p.status = 'PENDING' AND p.payment_kind = 'REFUND'
        ) pending ON true
        WHERE claim.clinic_id = %s AND f.refund_due > COALESCE(pending.amount, 0)
        ORDER BY f.invoice_id
        """,
        [clinic_id],
    )
    front = principal.allows("FRONT_DESK", clinic_id)
    accessible = set() if front else set(Invoice.objects.filter(
        manager_invoice_scope(principal), pk__in=[row["invoice_id"] for row in balances],
    ).values_list("pk", flat=True))
    for row in balances:
        invoice_id = row["invoice_id"]
        yield {
            "id": None, "kind": "TREATMENT_REFUND_DUE", "clinic_id": str(clinic_id), "status": "DUE",
            "amount": amount_data(row["amount"]), "requested_at": None, "receipt_at": None,
            "cross_day": None, "reason": None, "retained_amount": None,
            "source": {"kind": "invoice", "id": str(invoice_id)} if front or invoice_id in accessible else None,
        }


def settled_totals(settled):
    totals = dict.fromkeys(TOTAL_KEYS.values(), ZERO)
    for row in settled:
        totals[TOTAL_KEYS[row["kind"]]] += Decimal(row["amount"])
    for prefix in ("deposit", "treatment"):
        totals[prefix + "_net"] = totals[prefix + "_received"] - totals[prefix + "_refunded"]
    return {name: amount_data(amount) for name, amount in totals.items()}


@api_view(["GET"])
def reconciliation(request):
    filters = values(ReconciliationQuery, request.query_params)
    clinic_id, day = filters["clinic_id"], filters["date"]
    principal = request.user
    if not any(principal.allows(role, clinic_id) for role in ("FRONT_DESK", "CLINIC_MANAGER")):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能查询此门店的日结对账。")

    start = datetime.combine(day, time.min, BUSINESS_ZONE)
    end = start + timedelta(days=1)
    with consistent_read():
        with connection.cursor() as cursor:
            cursor.execute("SELECT statement_timestamp()")
            cutoff, = cursor.fetchone()
        clinic = get_object_or_404(Clinic.objects.only("clinic_name"), pk=clinic_id)
        entries = [
            *deposit_funds(clinic_id, start, end, cutoff),
            *treatment_funds(principal, clinic_id, start, end, cutoff),
        ]
        refund_due = list(treatment_refunds_due(principal, clinic_id))

    settled, pending, retained, failed_deposits = [], [], [], []
    for row in entries:
        if row["status"] == "PENDING":
            pending.append(row)
        elif row["status"] == "RETAINED":
            retained.append(row)
        elif row["status"] == "FAILED":
            failed_deposits.append(row)
        else:
            settled.append(row)
    settled.sort(key=lambda row: (row["receipt_at"], row["kind"], int(row["id"])))
    pending.sort(key=lambda row: (row["requested_at"] is None, row["requested_at"], row["kind"], int(row["id"])))
    retained.sort(key=lambda row: (row["requested_at"], int(row["id"])))
    failed_deposits.sort(key=lambda row: (row["requested_at"], int(row["id"])))
    return success({
        "clinic_id": str(clinic.pk), "clinic_name": clinic.clinic_name, "date": day.isoformat(),
        "as_of": local_timestamp(cutoff), "historical": day < cutoff.astimezone(BUSINESS_ZONE).date(),
        "totals": settled_totals(settled), "settled": settled, "pending": pending, "retained": retained,
        "refund_due": failed_deposits + refund_due,
    })


urlpatterns = [path("billing/reconciliation", reconciliation)]
