from collections import Counter
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.db.models import Q

from adc.billing.invoice_service import ZERO, amount_data
from adc.billing.models import InvoiceLine, InvoicePayment
from adc.clinical.models import Visit
from adc.common.http import ApiProblem
from adc.identity.models import Clinic, EmployeeRole
from adc.reporting import fact_queries
from adc.reporting.models import DentistPerformance
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.reporting.permissions import QUERY, filter_clinics, includes_company, visible_scope
from adc.scheduling.models import EmployeeQualification, Shift


APPOINTMENT_GROUPS = ("attended", "patient_cancelled", "no_show", "unprocessed", "clinic_cancelled", "unclassified")
MONEY = ("revenue", "material_cost", "operating_cost", "net_profit")


def rate(numerator, denominator, *, incomplete=False):
    if incomplete:
        availability, value = "MISSING", None
    elif denominator == 0:
        availability, value = "NOT_APPLICABLE", None
    else:
        availability = "AVAILABLE"
        value = format((Decimal(numerator) / Decimal(denominator)).normalize(), "f")
    return {"numerator": numerator, "denominator": denominator, "availability": availability, "value": value}


def authorized_filters(principal, filters):
    scope = visible_scope(principal, QUERY)
    clinic_query = filter_clinics(Clinic.objects.all(), scope, "pk")
    clinics = set(clinic_query.values_list("pk", flat=True))
    requested = set(filters.get("clinic_ids", []))
    if requested - clinics:
        raise ApiProblem(403, "PERMISSION_DENIED", "查询包含当前账号无法访问的门店。")
    clinics = requested or clinics
    dentists = set(filters.get("dentist_ids", []))
    if dentists:
        staffed = set(EmployeeRole.objects.filter(
            role__role_code="DENTIST", scope_clinic_id__in=clinics, employee_id__in=dentists,
        ).values_list("employee_id", flat=True))
        staffed.update(Shift.objects.filter(clinic_id__in=clinics, dentist_id__in=dentists).values_list("dentist_id", flat=True))
        staffed.update(Visit.objects.filter(
            appointment__claim__clinic_id__in=clinics, main_dentist_id__in=dentists,
        ).values_list("main_dentist_id", flat=True))
        if dentists - staffed:
            raise ApiProblem(403, "PERMISSION_DENIED", "查询包含当前范围无法访问的牙医。")
    return sorted(clinics), sorted(dentists)


def appointment_group(row):
    if row["clinic_cancelled"]:
        return "clinic_cancelled"
    if row["actual"]:
        return "attended"
    if row["patient_cancelled"]:
        return "patient_cancelled"
    if row["status"] == "NO_SHOW" and row["verified_no_show"]:
        return "no_show"
    if row["status"] in {"CONFIRMED", "CHECKED_IN"} and not row["is_attended"]:
        return "unprocessed"
    return "unclassified"


def appointment_metrics(first, last, cutoff, clinics, dentists, details):
    for row in fact_queries.appointment_facts(first, last, cutoff, clinics, dentists):
        details[appointment_group(row)].append({
            "appointment_id": str(row["appointment_id"]), "appointment_no": row["appointment_no"],
            "clinic_id": str(row["clinic_id"]), "dentist_id": str(row["dentist_id"]),
            "service_date": row["service_date"].isoformat(), "slot_end_at": row["slot_end_at"].isoformat(),
            "status": row["status"],
        })
    counts = {key: len(details[key]) for key in APPOINTMENT_GROUPS}
    denominator = sum(counts[key] for key in APPOINTMENT_GROUPS[:4])
    return {
        **counts, "denominator": denominator,
        "attendance_rate": rate(counts["attended"], denominator, incomplete=bool(counts["unclassified"])),
        "cancellation_rate": rate(counts["patient_cancelled"], denominator, incomplete=bool(counts["unclassified"])),
        "by_clinic": [
            {"clinic_id": str(clinic), **{
                group: sum(row["clinic_id"] == str(clinic) for row in details[group])
                for group in APPOINTMENT_GROUPS
            }} for clinic in clinics
        ],
    }


def visit_metrics(visit_query, start, end, cutoff, clinics, dentists, details):
    selected = (
        ("actual_starts", visit_query.filter(started_at__gte=start, started_at__lt=end, started_at__lte=cutoff), "started_at"),
        ("normal_completions", visit_query.filter(status="COMPLETED", ended_at__gte=start, ended_at__lt=end, ended_at__lte=cutoff), "ended_at"),
    )
    for metric, query, date_field in selected:
        for visit in query.order_by(date_field, "pk").values(
            "pk", date_field, "status", "appointment__claim__clinic_id", "main_dentist_id",
        ):
            details[metric].append({
                "visit_id": str(visit["pk"]), "clinic_id": str(visit["appointment__claim__clinic_id"]),
                "dentist_id": str(visit["main_dentist_id"]), "status": visit["status"],
                "occurred_at": visit[date_field].isoformat(),
            })
    for item in fact_queries.treatment_facts(start, end, cutoff, clinics, dentists):
        details["actual_treatments"].append({
            "item_id": str(item["item_id"]), "visit_id": str(item["visit_id"]), "clinic_id": str(item["clinic_id"]),
            "dentist_id": str(item["dentist_id"]), "treatment_code": item["treatment_code"],
            "units": format(item["units"], ".3f"), "unit": item["unit_name_snapshot"], "occurred_at": item["occurred_at"].isoformat(),
        })
    return {metric: len(details[metric]) for metric in ("actual_starts", "normal_completions", "actual_treatments")}


def coverage_metric(visit_query, start, end, cutoff, details):
    lines = InvoiceLine.objects.filter(
        invoice__visit__in=visit_query, invoice__issued_at__gte=start, invoice__issued_at__lt=end, invoice__issued_at__lte=cutoff,
    ).select_related("treatment_item", "invoice__visit__appointment__claim").order_by("pk")
    for line in lines:
        visit, item = line.invoice.visit, line.treatment_item
        standard = bool(
            item.visit_id == visit.pk and line.unit_name_snapshot and line.unit_name_snapshot == item.unit_name_snapshot
            and line.units == item.units and line.unit_price == item.unit_price_snapshot and line.subtotal == item.amount
        )
        details["coverage"].append({
            "invoice_id": str(line.invoice_id), "line_id": str(line.pk), "clinic_id": str(visit.appointment.claim.clinic_id),
            "dentist_id": str(visit.main_dentist_id), "matches_standard": standard, "treatment_name": line.treatment_name_snapshot,
            "unit": line.unit_name_snapshot, "unit_price": amount_data(line.unit_price),
        })
    return rate(sum(row["matches_standard"] for row in details["coverage"]), len(details["coverage"]))


def financial_metrics(visit_query, start, end, cutoff, clinics, dentists, details):
    accrued = outstanding = ZERO
    for fact in fact_queries.invoice_facts(start, end, cutoff, clinics, dentists):
        invoice_outstanding = max(fact["accrued_amount"] - fact["net_received"], ZERO)
        detail = {
            "invoice_id": str(fact["invoice_id"]), "invoice_no": fact["invoice_no"], "visit_id": str(fact["visit_id"]),
            "clinic_id": str(fact["clinic_id"]), "dentist_id": str(fact["dentist_id"]),
            "ended_at": fact["ended_at"].isoformat(), "accrued": amount_data(fact["accrued_amount"]),
            "outstanding": amount_data(invoice_outstanding),
        }
        details["accrued"].append(detail)
        accrued += fact["accrued_amount"]
        if invoice_outstanding > 0:
            outstanding += invoice_outstanding
            details["outstanding"].append(detail)
    flows = InvoicePayment.objects.filter(
        invoice__visit__in=visit_query, paid_at__gte=start, paid_at__lt=end, paid_at__lte=cutoff, status="SUCCEEDED",
    ).select_related("invoice__visit__appointment__claim").order_by("paid_at", "pk")
    received = refunded = ZERO
    for flow in flows:
        visit = flow.invoice.visit
        detail = {
            "payment_id": str(flow.pk), "invoice_id": str(flow.invoice_id), "clinic_id": str(visit.appointment.claim.clinic_id),
            "dentist_id": str(visit.main_dentist_id), "paid_at": flow.paid_at.isoformat(),
            "amount": amount_data(flow.amount), "kind": flow.payment_kind,
        }
        if flow.payment_kind == "PAYMENT":
            received += flow.amount
            details["received"].append(detail)
        else:
            refunded += flow.amount
            details["refunded"].append(detail)
        details["net_received"].append(detail)
    return {
        key: amount_data(value) for key, value in {
            "accrued": accrued, "received": received, "refunded": refunded, "net_received": received - refunded,
            "outstanding": outstanding,
        }.items()
    }


def qualification_metrics(clinics, dentists, date, details):
    placements = EmployeeRole.objects.filter(role__role_code="DENTIST", scope_clinic_id__in=clinics, employee__status="ACTIVE")
    if dentists:
        placements = placements.filter(employee_id__in=dentists)
    offices = {}
    for employee, clinic in placements.values_list("employee_id", "scope_clinic_id").order_by("employee_id", "scope_clinic_id"):
        offices.setdefault(employee, []).append(clinic)
    credentials = EmployeeQualification.objects.filter(employee_id__in=offices).filter(
        Q(valid_from__isnull=True) | Q(valid_from__lte=date), Q(valid_until__isnull=True) | Q(valid_until__gte=date),
    ).select_related("qualification").order_by("qualification__qualification_code", "employee_id")
    counts = Counter()
    seen = set()
    for row in credentials:
        code = row.qualification.qualification_code
        identity = (row.employee_id, code)
        if identity in seen:
            continue
        seen.add(identity)
        counts[(code, row.qualification.qualification_name)] += 1
        for clinic in offices[row.employee_id]:
            details["skills"].append({
                "clinic_id": str(clinic), "dentist_id": str(row.employee_id),
                "qualification_code": code, "qualification_name": row.qualification.qualification_name,
            })
    return [{"code": code, "name": name, "dentists": count} for (code, name), count in sorted(counts.items())]


def quarter_key(day):
    return day.year, (day.month - 1) // 3 + 1


def performance_metrics(first, last, clinics, dentists, details):
    company = fact_queries.confirmed_company_facts(quarter_key(first), quarter_key(last))
    full = not dentists and includes_company(set(clinics))
    summaries = []
    for row in company:
        contributions = DentistPerformance.objects.filter(
            period_id=row["period_id"], revision_no=row["revision_no"], clinic_id__in=clinics,
        ).order_by("clinic_id", "dentist_id")
        if dentists:
            contributions = contributions.filter(dentist_id__in=dentists)
        for contribution in contributions:
            details["performance"].append({
                "period_id": str(contribution.period_id), "revision_no": contribution.revision_no,
                "clinic_id": str(contribution.clinic_id), "dentist_id": str(contribution.dentist_id),
                **{key: amount_data(getattr(contribution, key)) for key in MONEY},
            })
        result = {
            "period_id": str(row["period_id"]), "year": row["perf_year"], "quarter": row["perf_quarter"],
            "revision_no": row["revision_no"],
        }
        if full:
            keys = (*MONEY, "incentive_fund")
            result.update({
                "company": {key: amount_data(row[key]) for key in keys},
                "original_company": {key: amount_data(row["original_" + key]) for key in keys},
                "company_delta": {key: amount_data(row[key + "_delta"]) for key in keys},
            })
        summaries.append(result)
    if not dentists:
        for expense in fact_queries.closed_period_expense_facts([row["period_id"] for row in company], clinics):
            details["expenses"].append({
                "expense_id": str(expense["expense_id"]), "period_id": str(expense["period_id"]),
                "clinic_id": str(expense["clinic_id"]), "scope": expense["scope"],
                **{key: amount_data(expense[key]) for key in ("amount", "attributed", "unallocated")},
            })
    return summaries


def report(principal, filters, cutoff):
    clinics, dentists = authorized_filters(principal, filters)
    first, last = filters["date_from"], filters["date_to"]
    start = datetime.combine(first, time.min, tzinfo=BUSINESS_ZONE)
    end = datetime.combine(last + timedelta(days=1), time.min, tzinfo=BUSINESS_ZONE)
    visit_query = Visit.objects.filter(appointment__claim__clinic_id__in=clinics)
    if dentists:
        visit_query = visit_query.filter(main_dentist_id__in=dentists)
    details = {key: [] for key in (
        *APPOINTMENT_GROUPS, "actual_starts", "normal_completions", "actual_treatments", "coverage", "accrued",
        "outstanding", "received", "refunded", "net_received", "skills", "performance", "expenses",
    )}
    metadata = {
        "date_from": first.isoformat(), "date_to": last.isoformat(), "as_of": cutoff.astimezone(BUSINESS_ZONE).isoformat(),
        "scope": {"clinic_ids": list(map(str, clinics)), "dentist_ids": list(map(str, dentists))},
        "sources": {
            "appointments": "最终预约时段本地日期及实际到期", "clinical": "就诊实际开始、结束和实施项目本地日期",
            "financial": "按就诊结束日期统计截至查询时的应计及欠款，按回执本地日期统计已成功收退",
            "coverage": "主单开立本地日期及冻结计费行",
            "skills": "查询截止日的有效资格", "performance": "自然季度内最新已确认版本",
        },
    }
    results = {
        "appointments": appointment_metrics(first, last, cutoff, clinics, dentists, details),
        "clinical": visit_metrics(visit_query, start, end, cutoff, clinics, dentists, details),
        "standard_coverage": coverage_metric(visit_query, start, end, cutoff, details),
        "financial": financial_metrics(visit_query, start, end, cutoff, clinics, dentists, details),
        "skills": qualification_metrics(clinics, dentists, cutoff.astimezone(BUSINESS_ZONE).date(), details),
        "performance": performance_metrics(first, last, clinics, dentists, details),
        "detail_metrics": list(details),
    }
    return metadata, results, details
