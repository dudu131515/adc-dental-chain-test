from contextlib import contextmanager

from django.db import connection, transaction


@contextmanager
def consistent_read():
    outermost = not connection.in_atomic_block
    with transaction.atomic():
        if outermost:
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        yield


def rows(statement, parameters):
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        headers = [column.name for column in cursor.description]
        return [dict(zip(headers, row, strict=True)) for row in cursor.fetchall()]


def appointment_facts(date_from, date_to, cutoff, clinics, dentists):
    return rows(
        """
        SELECT f.*, a.appointment_no, sc.start_at AS slot_start_at,
               EXISTS (SELECT 1 FROM visit v WHERE v.appointment_id = f.appointment_id AND v.started_at <= %s) AS actual,
               EXISTS (SELECT 1 FROM appointment_change c WHERE c.appointment_id = f.appointment_id
                       AND c.change_type = 'NO_SHOW') AS verified_no_show
        FROM appointment_reporting_fact f JOIN appointment a ON a.appointment_id = f.appointment_id
        JOIN slot_claim sc ON sc.claim_id = a.claim_id
        WHERE f.service_date BETWEEN %s AND %s AND f.slot_end_at <= %s AND f.clinic_id = ANY(%s)
          AND (%s OR f.dentist_id = ANY(%s))
        ORDER BY f.service_date, f.slot_end_at, f.appointment_id
        """,
        [cutoff, date_from, date_to, cutoff, clinics, not dentists, dentists],
    )


def invoice_facts(start, end, cutoff, clinics, dentists):
    # The live balance view includes adjustments and receipts after a report's cutoff.
    return rows(
        """
        SELECT i.invoice_id, i.invoice_no, i.visit_id, c.clinic_id, v.main_dentist_id AS dentist_id, v.ended_at,
               i.original_total + COALESCE(adjustments.amount, 0) AS accrued_amount,
               COALESCE(receipts.net_amount, 0) AS net_received
        FROM invoice i
        JOIN visit v ON v.visit_id = i.visit_id
        JOIN appointment a ON a.appointment_id = v.appointment_id
        JOIN slot_claim c ON c.claim_id = a.claim_id
        LEFT JOIN LATERAL (
            SELECT SUM(signed_amount) AS amount
            FROM invoice_adjustment WHERE invoice_id = i.invoice_id AND created_at <= %s
        ) adjustments ON true
        LEFT JOIN LATERAL (
            SELECT SUM(CASE payment_kind WHEN 'PAYMENT' THEN amount ELSE -amount END) AS net_amount
            FROM invoice_payment WHERE invoice_id = i.invoice_id AND status = 'SUCCEEDED' AND paid_at <= %s
        ) receipts ON true
        WHERE v.ended_at >= %s AND v.ended_at < %s AND v.ended_at <= %s AND i.issued_at <= %s
          AND c.clinic_id = ANY(%s) AND (%s OR v.main_dentist_id = ANY(%s))
        ORDER BY v.ended_at, i.invoice_id
        """,
        [cutoff, cutoff, start, end, cutoff, cutoff, clinics, not dentists, dentists],
    )


def treatment_facts(start, end, cutoff, clinics, dentists):
    return rows(
        """
        SELECT t.item_id, t.visit_id, t.performing_dentist_id AS dentist_id, c.clinic_id, p.treatment_code,
               t.units, t.unit_name_snapshot, COALESCE(proof.performed_at, t.recorded_at) AS occurred_at
        FROM treatment_item t JOIN treatment_type p ON p.treatment_type_id = t.treatment_type_id
        JOIN visit v ON v.visit_id = t.visit_id
        JOIN appointment a ON a.appointment_id = v.appointment_id
        JOIN slot_claim c ON c.claim_id = a.claim_id
        LEFT JOIN LATERAL (
            SELECT (event.after_value->>'performed_at')::timestamptz AS performed_at
            FROM audit_log event
            WHERE event.action = 'TREATMENT_ITEM_RECORDED' AND event.target_type = 'treatment_item' AND event.target_id = t.item_id
            ORDER BY event.id DESC LIMIT 1
        ) proof ON true
        WHERE c.clinic_id = ANY(%s) AND (%s OR t.performing_dentist_id = ANY(%s))
          AND COALESCE(proof.performed_at, t.recorded_at) >= %s
          AND COALESCE(proof.performed_at, t.recorded_at) < %s
          AND COALESCE(proof.performed_at, t.recorded_at) <= %s AND t.recorded_at <= %s
        ORDER BY occurred_at, t.item_id
        """,
        [clinics, not dentists, dentists, start, end, cutoff, cutoff],
    )


def confirmed_company_facts(first_quarter, last_quarter):
    return rows(
        """
        SELECT DISTINCT ON (period_id) period_id, revision_no, perf_year, perf_quarter,
               revenue, material_cost, operating_cost, net_profit, incentive_fund,
               original_revenue, original_material_cost, original_operating_cost, original_net_profit,
               original_incentive_fund, revenue_delta, material_cost_delta, operating_cost_delta,
               net_profit_delta, incentive_fund_delta
        FROM company_performance_revision_fact
        WHERE confirmed_at IS NOT NULL
          AND (perf_year, perf_quarter) >= (%s, %s) AND (perf_year, perf_quarter) <= (%s, %s)
        ORDER BY period_id, revision_no DESC
        """,
        [*first_quarter, *last_quarter],
    )


def closed_period_expense_facts(periods, clinics):
    return rows(
        """
        SELECT f.expense_id, f.period_id, f.clinic_id, f.scope, f.dentist_id, f.amount, f.attributed, f.unallocated
        FROM expense_reporting_fact f JOIN performance_period p ON p.period_id = f.period_id AND p.status = 'CONFIRMED'
        WHERE f.period_id = ANY(%s) AND f.clinic_id = ANY(%s)
        ORDER BY f.period_id, f.expense_id
        """,
        [periods, clinics],
    )
