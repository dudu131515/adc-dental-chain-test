from datetime import datetime
import re
from urllib.parse import unquote

from django.db import connection
from django.utils.crypto import salted_hmac
from rest_framework import serializers

from adc.common.http import ApiProblem, cursor_position, scoped_cursor
from adc.common.serializers import ID, values


PAGE_SIZE = 20
STATES = (
    "WAITING_INVOICE", "WAITING_PAYMENT", "PARTIAL_PAYMENT", "SETTLED",
    "REFUND_DUE", "REFUND_PENDING", "INVOICED",
)


class QueueFilters(serializers.Serializer):
    clinic_id = ID(required=False)
    status = serializers.ChoiceField(choices=STATES, required=False)
    cursor = serializers.CharField(required=False, max_length=3000)
    q = serializers.CharField(required=False, allow_blank=True, max_length=150)


def search_term(request):
    try:
        return unquote(request.headers.get("X-ADC-Queue-Search", ""), errors="strict")
    except UnicodeDecodeError:
        raise ApiProblem(400, "VALIDATION_ERROR", "搜索词格式不正确。") from None


def queue_data(request):
    principal = request.user
    principal.require("FRONT_DESK")
    filters = values(QueueFilters, {
        **request.query_params.dict(), "q": search_term(request),
    })
    clinic = filters.get("clinic_id")
    if clinic is not None:
        principal.require("FRONT_DESK", clinic)
    clinics = [clinic] if clinic is not None else sorted(principal.clinic_scope("FRONT_DESK"))
    term = filters["q"]
    status = filters.get("status", "")
    binding = [str(principal.account_id), clinics, status, salted_hmac("adc.billing.queue", term).hexdigest()]
    criteria = ["v.status IN ('COMPLETED', 'TERMINATED')", "s.clinic_id = ANY(%s)"]
    arguments = [clinics]
    if term:
        criteria.append("""(
            p.phone = %s OR STRPOS(UPPER(p.full_name), UPPER(%s)) > 0
            OR STRPOS(UPPER(a.appointment_no), UPPER(%s)) > 0
            OR STRPOS(UPPER(i.invoice_no), UPPER(%s)) > 0
        )""")
        arguments.extend([term] * 4)
    if filters.get("cursor"):
        ended_at, visit_id = cursor_position(filters["cursor"], binding)
        criteria.append("(v.ended_at, v.visit_id) < (%s, %s)")
        arguments.extend([datetime.fromisoformat(ended_at), int(visit_id)])

    scoped = f"""
        SELECT v.visit_id, a.appointment_no, s.clinic_id, c.clinic_name, v.ended_at,
               v.status, i.invoice_id, i.invoice_no, p.full_name, p.phone,
               facts.outstanding_amount, facts.refund_due,
               COALESCE(pending.total, 0) AS pending_refund,
               CASE WHEN i.invoice_id IS NULL THEN 'WAITING_INVOICE'
                    WHEN pending.total > 0 THEN 'REFUND_PENDING'
                    WHEN facts.refund_due > 0 THEN 'REFUND_DUE'
                    WHEN facts.outstanding_amount = 0 THEN 'SETTLED'
                    WHEN facts.received_amount > facts.refunded_amount THEN 'PARTIAL_PAYMENT'
                    ELSE 'WAITING_PAYMENT'
               END AS billing_state
        FROM visit v
        JOIN appointment a ON a.appointment_id = v.appointment_id
        JOIN slot_claim s ON s.claim_id = a.claim_id
        JOIN patient p ON p.patient_id = s.patient_id
        JOIN clinic c ON c.clinic_id = s.clinic_id
        LEFT JOIN invoice i ON i.visit_id = v.visit_id
        LEFT JOIN invoice_reporting_fact facts ON facts.invoice_id = i.invoice_id
        LEFT JOIN LATERAL (
            SELECT SUM(amount) AS total
            FROM invoice_payment
            WHERE invoice_id = i.invoice_id AND payment_kind = 'REFUND' AND status = 'PENDING'
        ) pending ON TRUE
        WHERE {" AND ".join(criteria)}
    """
    state_filter = ""
    if status == "INVOICED":
        state_filter = "WHERE invoice_id IS NOT NULL"
    elif status == "REFUND_DUE":
        state_filter = "WHERE refund_due > pending_refund"
    elif status:
        state_filter = "WHERE billing_state = %s"
        arguments.append(status)
    arguments.append(PAGE_SIZE + 1)

    with connection.cursor() as cursor:
        cursor.execute(f"""
            SELECT * FROM ({scoped}) queue
            {state_filter}
            ORDER BY ended_at DESC, visit_id DESC
            LIMIT %s
        """, arguments)
        rows = cursor.fetchall()

    items = []
    for (visit_id, appointment_no, clinic_id, name, ended, visit_status, invoice_id, invoice_no,
         patient, phone, outstanding, refund_due, pending_refund, billing_state) in rows[:PAGE_SIZE]:
        digits = re.sub(r"[^0-9]", "", phone or "")
        items.append({
            "visit_id": str(visit_id), "appointment_no": appointment_no,
            "clinic_id": str(clinic_id), "clinic_name": name, "ended_at": ended.isoformat(),
            "status": visit_status, "invoice_id": str(invoice_id) if invoice_id else None, "invoice_no": invoice_no,
            "patient_display": {"name": patient, "phone_tail": digits[-4:] if len(digits) >= 4 else None},
            "billing_state": billing_state,
            "outstanding": format(outstanding, ".2f") if outstanding is not None else None,
            "refund_remaining": format(max(refund_due - pending_refund, 0), ".2f") if refund_due else "0.00",
            "pending_refund": format(pending_refund, ".2f"),
        })
    next_cursor = None
    if len(rows) > PAGE_SIZE:
        last = items[-1]
        next_cursor = scoped_cursor(binding, [last["ended_at"], last["visit_id"]])
    return {"items": items, "next_cursor": next_cursor}
