"""Operating facts that make the headquarters overview match live business records.

The overview reuses the same appointment, invoice and treatment records as the
operating report.  Material cost is the frozen usage snapshot on each treatment
item; operating expenses are recorded per quarter and prorated by calendar day
so that a month or a custom range is not distorted by a full quarter of cost.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.db.models import Count

from adc.billing.invoice_service import ZERO, amount_data
from adc.clinical.models import DentistWorkSession, MaterialUsage, TreatmentItem, Visit
from adc.identity.models import Clinic, Employee
from adc.reporting import fact_queries
from adc.reporting.models import OperatingExpense
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.models import DentalChair, Shift


CENT = Decimal("0.01")
ONE = Decimal("1")
APPOINTMENT_GROUPS = ("attended", "patient_cancelled", "no_show", "unprocessed", "clinic_cancelled", "unclassified")
OCCUPYING_GROUPS = {"attended", "unprocessed"}
TREND_DAY_LIMIT = 62


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


def rate(numerator, denominator, *, incomplete=False):
    if incomplete:
        availability, value = "MISSING", None
    elif not denominator:
        availability, value = "NOT_APPLICABLE", None
    else:
        availability = "AVAILABLE"
        value = format((Decimal(numerator) / Decimal(denominator)).normalize(), "f")
    return {"numerator": numerator, "denominator": denominator, "availability": availability, "value": value}


def _day(value):
    return value.astimezone(BUSINESS_ZONE).date()


def _minutes(start_at, end_at):
    if start_at is None or end_at is None or end_at <= start_at:
        return ZERO
    return Decimal(str((end_at - start_at).total_seconds())) / Decimal("60")


def _quarter_dates(year, quarter):
    month = (quarter - 1) * 3 + 1
    start = date(year, month, 1)
    end = date(year + (month == 10), (month + 2) % 12 + 1, 1)
    return start, end


def _prorated(value, period, first, last):
    quarter_start, quarter_end = _quarter_dates(period.perf_year, period.perf_quarter)
    low, high = max(first, quarter_start), min(last, quarter_end)
    days = (high - low).days
    if days <= 0:
        return ZERO
    return (value * Decimal(days) / Decimal((quarter_end - quarter_start).days)).quantize(CENT, rounding=ROUND_HALF_UP)


def _merge_intervals(intervals):
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged = [list(ordered[0])]
    for start, end in ordered[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def _bucket_definitions(first, last):
    if (last - first).days <= TREND_DAY_LIMIT:
        buckets = []
        day = first
        while day <= last:
            buckets.append({"key": day.isoformat(), "label": day.strftime("%m-%d"), "start": day,
                            "end": day + timedelta(days=1), "granularity": "day"})
            day += timedelta(days=1)
        return buckets, "day"
    buckets = []
    cursor = date(first.year, first.month, 1)
    while cursor <= last:
        next_month = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
        buckets.append({"key": cursor.strftime("%Y-%m"), "label": cursor.strftime("%Y年%m月"), "start": cursor,
                        "end": next_month, "granularity": "month"})
        cursor = next_month
    return buckets, "month"


def _bucket_key(day, granularity):
    return day.isoformat() if granularity == "day" else day.strftime("%Y-%m")


def collect(first, last, start, end, cutoff, clinics, dentists, as_of_date):
    """Return the business, workload, resource and trend blocks for one report snapshot."""
    clinic_names = dict(Clinic.objects.filter(pk__in=clinics).values_list("clinic_id", "clinic_name"))
    clinic_ids = [clinic for clinic in clinics if clinic in clinic_names]

    invoice_rows = list(fact_queries.invoice_facts(start, end, cutoff, clinic_ids, dentists))
    visit_query = Visit.objects.filter(
        ended_at__gte=start, ended_at__lt=end, ended_at__lte=cutoff,
        appointment__claim__clinic_id__in=clinic_ids,
    )
    if dentists:
        visit_query = visit_query.filter(main_dentist_id__in=dentists)
    visit_rows = list(visit_query.values(
        "visit_id", "status", "ended_at", "appointment__claim__clinic_id", "main_dentist_id",
    ))

    material_query = MaterialUsage.objects.filter(
        treatment_item__visit__ended_at__gte=start, treatment_item__visit__ended_at__lt=end,
        treatment_item__visit__ended_at__lte=cutoff, treatment_item__visit__appointment__claim__clinic_id__in=clinic_ids,
        treatment_item__recorded_at__lte=cutoff,
    )
    if dentists:
        material_query = material_query.filter(treatment_item__performing_dentist_id__in=dentists)
    material_rows = list(material_query.values(
        "id", "quantity", "unit_cost_snapshot", "material_name_snapshot", "material__material_name",
        "treatment_item__visit_id", "treatment_item__performing_dentist_id",
        "treatment_item__visit__appointment__claim__clinic_id", "treatment_item__visit__ended_at",
    ))

    treatment_query = TreatmentItem.objects.filter(
        visit__ended_at__gte=start, visit__ended_at__lt=end, visit__ended_at__lte=cutoff,
        visit__appointment__claim__clinic_id__in=clinic_ids,
    )
    treatment_rows = list(treatment_query.values(
        "performing_dentist_id", "visit__appointment__claim__clinic_id",
    ).annotate(total=Count("item_id")))

    work_query = DentistWorkSession.objects.filter(
        started_at__gte=start, started_at__lt=end, started_at__lte=cutoff,
        visit__appointment__claim__clinic_id__in=clinic_ids,
    )
    if dentists:
        work_query = work_query.filter(dentist_id__in=dentists)
    work_rows = list(work_query.values(
        "id", "dentist_id", "duration_minutes", "started_at", "visit_id", "visit__appointment__claim__clinic_id",
    ))
    all_work_rows = list(DentistWorkSession.objects.filter(
        started_at__gte=start, started_at__lt=end, started_at__lte=cutoff,
        visit__appointment__claim__clinic_id__in=clinic_ids,
    ).values("dentist_id", "duration_minutes", "visit__appointment__claim__clinic_id"))

    appointment_rows = list(fact_queries.appointment_facts(first, last, cutoff, clinic_ids, dentists))
    shift_rows = list(Shift.objects.filter(
        clinic_id__in=clinic_ids, status="PUBLISHED", start_at__lt=end, end_at__gt=start,
    ).values("clinic_id", "dentist_id", "start_at", "end_at"))
    chair_rows = DentalChair.objects.filter(clinic_id__in=clinic_ids, status="AVAILABLE").values(
        "clinic_id",
    ).annotate(total=Count("chair_id"))
    chair_count = {row["clinic_id"]: row["total"] for row in chair_rows}

    employee_ids = {row["main_dentist_id"] for row in visit_rows}
    employee_ids.update(row["dentist_id"] for row in invoice_rows)
    employee_ids.update(row["treatment_item__performing_dentist_id"] for row in material_rows)
    employee_ids.update(row["performing_dentist_id"] for row in treatment_rows)
    employee_ids.update(row["dentist_id"] for row in work_rows)
    employee_ids.update(row["dentist_id"] for row in shift_rows)
    employee_ids.discard(None)
    dentist_names = dict(Employee.objects.filter(pk__in=employee_ids).values_list("employee_id", "full_name"))

    def clinic_name(clinic):
        return clinic_names.get(clinic, str(clinic))

    def dentist_name(dentist):
        return dentist_names.get(dentist, str(dentist) if dentist is not None else "未指定")

    revenue_by_clinic = defaultdict(lambda: ZERO)
    revenue_by_dentist = defaultdict(lambda: ZERO)
    net_by_clinic = defaultdict(lambda: ZERO)
    material_by_clinic = defaultdict(lambda: ZERO)
    material_by_dentist = defaultdict(lambda: ZERO)
    work_by_clinic = defaultdict(lambda: ZERO)
    work_by_dentist = defaultdict(lambda: ZERO)
    visits_by_clinic = defaultdict(int)
    visits_by_dentist = defaultdict(int)
    treatments_by_clinic = defaultdict(int)
    treatments_by_dentist = defaultdict(int)
    revenue_rows = []
    for row in invoice_rows:
        clinic, dentist = row["clinic_id"], row["dentist_id"]
        revenue_by_clinic[clinic] += row["accrued_amount"]
        revenue_by_dentist[(clinic, dentist)] += row["accrued_amount"]
        net_by_clinic[clinic] += row["net_received"]
        revenue_rows.append({
            "clinic_id": str(clinic), "clinic_name": clinic_name(clinic),
            "dentist_id": str(dentist), "dentist_name": dentist_name(dentist),
            "invoice_no": row["invoice_no"], "visit_id": str(row["visit_id"]),
            "ended_at": row["ended_at"].isoformat(), "accrued": amount_data(row["accrued_amount"]),
            "net_received": amount_data(row["net_received"]),
        })
    for row in visit_rows:
        clinic, dentist = row["appointment__claim__clinic_id"], row["main_dentist_id"]
        visits_by_clinic[clinic] += 1
        visits_by_dentist[(clinic, dentist)] += 1
    for row in material_rows:
        clinic = row["treatment_item__visit__appointment__claim__clinic_id"]
        dentist = row["treatment_item__performing_dentist_id"]
        cost = row["quantity"] * row["unit_cost_snapshot"]
        material_by_clinic[clinic] += cost
        material_by_dentist[(clinic, dentist)] += cost
    for row in treatment_rows:
        clinic = row["visit__appointment__claim__clinic_id"]
        dentist = row["performing_dentist_id"]
        treatments_by_clinic[clinic] += row["total"]
        treatments_by_dentist[(clinic, dentist)] += row["total"]
    for row in work_rows:
        clinic, dentist = row["visit__appointment__claim__clinic_id"], row["dentist_id"]
        work_by_clinic[clinic] += row["duration_minutes"]
        work_by_dentist[(clinic, dentist)] += row["duration_minutes"]
    material_breakdown = []
    for row in material_rows:
        amount = row["quantity"] * row["unit_cost_snapshot"]
        material_breakdown.append({
            "clinic_id": str(row["treatment_item__visit__appointment__claim__clinic_id"]),
            "clinic_name": clinic_name(row["treatment_item__visit__appointment__claim__clinic_id"]),
            "dentist_id": str(row["treatment_item__performing_dentist_id"]),
            "dentist_name": dentist_name(row["treatment_item__performing_dentist_id"]),
            "visit_id": str(row["treatment_item__visit_id"]),
            "material_name": row["material_name_snapshot"] or row["material__material_name"],
            "quantity": format(row["quantity"], ".3f"), "unit_cost": amount_data(row["unit_cost_snapshot"]),
            "amount": amount_data(amount), "occurred_at": row["treatment_item__visit__ended_at"].isoformat(),
        })

    appointment_counts = defaultdict(lambda: defaultdict(int))
    occupied_by_day = defaultdict(lambda: ZERO)
    booked_by_clinic = defaultdict(lambda: ZERO)
    booked_by_dentist = defaultdict(lambda: ZERO)
    for row in appointment_rows:
        clinic, dentist, group = row["clinic_id"], row["dentist_id"], appointment_group(row)
        appointment_counts[clinic][group] += 1
        if group not in OCCUPYING_GROUPS:
            continue
        minutes = _minutes(row.get("slot_start_at"), row["slot_end_at"])
        occupied_by_day[(clinic, row["service_date"])] += minutes
        booked_by_clinic[clinic] += minutes
        booked_by_dentist[(clinic, dentist)] += minutes
    for clinic in clinic_ids:
        appointment_counts[clinic]["denominator"] = sum(
            appointment_counts[clinic][group] for group in APPOINTMENT_GROUPS[:4]
        )

    capacity_by_clinic = defaultdict(lambda: ZERO)
    capacity_by_day = defaultdict(lambda: ZERO)
    shift_by_clinic = defaultdict(lambda: ZERO)
    shift_by_dentist = defaultdict(lambda: ZERO)
    windows = defaultdict(list)
    capacity_end = min(end, datetime.combine(as_of_date + timedelta(days=1), time.min, tzinfo=BUSINESS_ZONE))
    for row in shift_rows:
        begin, finish = max(row["start_at"], start), min(row["end_at"], capacity_end)
        if begin >= finish:
            continue
        shift_by_clinic[row["clinic_id"]] += _minutes(begin, finish)
        shift_by_dentist[(row["clinic_id"], row["dentist_id"])] += _minutes(begin, finish)
        cursor = begin
        while cursor < finish:
            day = _day(cursor)
            next_day = datetime.combine(day + timedelta(days=1), time.min, tzinfo=BUSINESS_ZONE)
            segment_end = min(finish, next_day)
            windows[(row["clinic_id"], day)].append((cursor, segment_end))
            cursor = segment_end
    for (clinic, day), intervals in windows.items():
        chairs = chair_count.get(clinic, 0)
        minutes = sum((_minutes(start_at, end_at) for start_at, end_at in _merge_intervals(intervals)), ZERO)
        capacity_by_day[(clinic, day)] = minutes * chairs
        capacity_by_clinic[clinic] += minutes * chairs

    buckets, granularity = _bucket_definitions(first, min(last, as_of_date))
    points = {bucket["key"]: {
        "period": bucket["key"], "label": bucket["label"], "revenue": ZERO, "material_cost": ZERO,
        "operating_cost": ZERO, "net_profit": ZERO, "appointments": 0, "attended": 0, "visits": 0,
        "work_minutes": ZERO,
    } for bucket in buckets}

    def point(day):
        return points.get(_bucket_key(day, granularity))

    for row in invoice_rows:
        target = point(_day(row["ended_at"]))
        if target is not None:
            target["revenue"] += row["accrued_amount"]
    for row in material_rows:
        target = point(_day(row["treatment_item__visit__ended_at"]))
        if target is not None:
            target["material_cost"] += row["quantity"] * row["unit_cost_snapshot"]
    for row in visit_rows:
        target = point(_day(row["ended_at"]))
        if target is not None:
            target["visits"] += 1
    for row in work_rows:
        target = point(_day(row["started_at"]))
        if target is not None:
            target["work_minutes"] += row["duration_minutes"]
    for row in appointment_rows:
        target = point(row["service_date"])
        if target is not None:
            target["appointments"] += 1
            if appointment_group(row) == "attended":
                target["attended"] += 1

    minutes_by_clinic = defaultdict(lambda: defaultdict(lambda: ZERO))
    for row in all_work_rows:
        minutes_by_clinic[row["visit__appointment__claim__clinic_id"]][row["dentist_id"]] += row["duration_minutes"]
    expense_query = OperatingExpense.objects.filter(clinic_id__in=clinic_ids).select_related("period")
    expense_rows = list(expense_query.order_by("period__perf_year", "period__perf_quarter", "expense_id"))
    operating_by_clinic = defaultdict(lambda: ZERO)
    expense_breakdown = []
    categories = defaultdict(lambda: ZERO)
    periods_seen = {}
    effective_last = min(last, as_of_date)
    for row in expense_rows:
        if row.scope == "DIRECT" and dentists and row.dentist_id not in dentists:
            continue
        if row.scope == "SHARED" and dentists:
            all_minutes = sum(minutes_by_clinic[row.clinic_id].values(), ZERO)
            selected_minutes = sum(
                (minutes for dentist, minutes in minutes_by_clinic[row.clinic_id].items() if dentist in dentists), ZERO,
            )
            share = selected_minutes / all_minutes if all_minutes else ZERO
        else:
            share = ONE
        bucket_amounts = {}
        for bucket in buckets:
            value = _prorated(
                row.amount, row.period, max(bucket["start"], first),
                min(bucket["end"], effective_last + timedelta(days=1)),
            )
            amount = (value * share).quantize(CENT, rounding=ROUND_HALF_UP)
            bucket_amounts[bucket["key"]] = amount
            points[bucket["key"]]["operating_cost"] += amount
        allocated = sum(bucket_amounts.values(), ZERO)
        full_value = _prorated(row.amount, row.period, first, effective_last + timedelta(days=1))
        operating_by_clinic[row.clinic_id] += allocated
        if allocated <= 0:
            continue
        categories[row.expense_category] += allocated
        periods_seen[row.period_id] = {"period_id": str(row.period_id), "year": row.period.perf_year,
                                       "quarter": row.period.perf_quarter}
        expense_breakdown.append({
            "expense_id": str(row.expense_id), "clinic_id": str(row.clinic_id), "clinic_name": clinic_name(row.clinic_id),
            "period": f"{row.period.perf_year} 年第 {row.period.perf_quarter} 季度",
            "expense_category": row.expense_category, "scope": row.scope,
            "dentist_id": str(row.dentist_id) if row.dentist_id else None,
            "dentist_name": dentist_name(row.dentist_id) if row.dentist_id else None,
            "recorded_amount": amount_data(full_value), "amount": amount_data(allocated),
        })
    for bucket in buckets:
        target = points[bucket["key"]]
        target["net_profit"] = target["revenue"] - target["material_cost"] - target["operating_cost"]

    revenue = sum(revenue_by_clinic.values(), ZERO)
    material_cost = sum(material_by_clinic.values(), ZERO)
    operating_cost = sum(operating_by_clinic.values(), ZERO)
    net_profit = revenue - material_cost - operating_cost
    net_received = sum(net_by_clinic.values(), ZERO)

    workload_rows = []
    workload_keys = set(work_by_dentist) | set(revenue_by_dentist) | set(material_by_dentist) | set(visits_by_dentist)
    for clinic, dentist in workload_keys:
        minutes = work_by_dentist[(clinic, dentist)]
        workload_rows.append({
            "clinic_id": str(clinic), "clinic_name": clinic_name(clinic),
            "dentist_id": str(dentist), "dentist_name": dentist_name(dentist),
            "minutes": format(minutes, ".2f"), "hours": format(minutes / Decimal("60"), ".2f"),
            "visits": visits_by_dentist[(clinic, dentist)], "treatments": treatments_by_dentist[(clinic, dentist)],
            "revenue": amount_data(revenue_by_dentist[(clinic, dentist)]),
            "material_cost": amount_data(material_by_dentist[(clinic, dentist)]),
        })
    workload_rows.sort(key=lambda row: (Decimal(row["minutes"]), row["dentist_name"]), reverse=True)

    clinic_rows = []
    chair_details = []
    dentist_utilization = []
    for clinic in clinic_ids:
        denominator = appointment_counts[clinic]["denominator"]
        occupied = booked_by_clinic[clinic]
        capacity = capacity_by_clinic[clinic]
        effective_shift = shift_by_clinic[clinic]
        if dentists:
            effective_shift = sum(
                (shift_by_dentist[(clinic, dentist)] for dentist in dentists if (clinic, dentist) in shift_by_dentist),
                ZERO,
            )
        clinic_rows.append({
            "clinic_id": str(clinic), "clinic_name": clinic_name(clinic),
            "revenue": amount_data(revenue_by_clinic[clinic]), "net_received": amount_data(net_by_clinic[clinic]),
            "material_cost": amount_data(material_by_clinic[clinic]),
            "operating_cost": amount_data(operating_by_clinic[clinic]),
            "net_profit": amount_data(revenue_by_clinic[clinic] - material_by_clinic[clinic] - operating_by_clinic[clinic]),
            "appointments": denominator, "attended": appointment_counts[clinic]["attended"],
            "no_show": appointment_counts[clinic]["no_show"],
            "patient_cancelled": appointment_counts[clinic]["patient_cancelled"],
            "unprocessed": appointment_counts[clinic]["unprocessed"],
            "attendance_rate": rate(appointment_counts[clinic]["attended"], denominator),
            "visits": visits_by_clinic[clinic], "treatments": treatments_by_clinic[clinic],
            "work_minutes": format(work_by_clinic[clinic], ".2f"),
            "work_hours": format(work_by_clinic[clinic] / Decimal("60"), ".2f"),
            "chair_utilization": rate(occupied, capacity),
            "dentist_utilization": rate(sum(
                (booked_by_dentist[(clinic, dentist)] for dentist in dentists if (clinic, dentist) in booked_by_dentist),
                ZERO,
            ) if dentists else sum(
                (booked for (row_clinic, dentist), booked in booked_by_dentist.items() if row_clinic == clinic), ZERO,
            ), effective_shift),
        })
        chair_details.append({
            "clinic_id": str(clinic), "clinic_name": clinic_name(clinic),
            "occupied_minutes": format(occupied, ".0f"), "capacity_minutes": format(capacity, ".0f"),
            "active_chairs": chair_count.get(clinic, 0), "utilization": rate(occupied, capacity),
        })
    dentist_keys = set(shift_by_dentist) | set(booked_by_dentist) | set(work_by_dentist)
    for clinic, dentist in sorted(dentist_keys):
        dentist_utilization.append({
            "clinic_id": str(clinic), "clinic_name": clinic_name(clinic),
            "dentist_id": str(dentist), "dentist_name": dentist_name(dentist),
            "shift_minutes": format(shift_by_dentist[(clinic, dentist)], ".0f"),
            "booked_minutes": format(booked_by_dentist[(clinic, dentist)], ".0f"),
            "work_minutes": format(work_by_dentist[(clinic, dentist)], ".0f"),
            "utilization": rate(booked_by_dentist[(clinic, dentist)], shift_by_dentist[(clinic, dentist)]),
            "work_utilization": rate(work_by_dentist[(clinic, dentist)], shift_by_dentist[(clinic, dentist)]),
        })

    total_shift = sum(shift_by_clinic.values(), ZERO)
    total_booked = sum(booked_by_clinic.values(), ZERO)
    total_work = sum(work_by_clinic.values(), ZERO)
    total_capacity = sum(capacity_by_clinic.values(), ZERO)
    total_occupied = sum(booked_by_clinic.values(), ZERO)
    resources = {
        "active_chairs": sum(chair_count.values()),
        "chair_occupied_minutes": format(total_occupied, ".0f"),
        "chair_capacity_minutes": format(total_capacity, ".0f"),
        "chair_utilization": rate(total_occupied, total_capacity),
        "open_chair_days": len({day for (clinic, day) in capacity_by_day if capacity_by_day[(clinic, day)] > 0}),
        "dentist_shift_minutes": format(total_shift, ".0f"),
        "dentist_booked_minutes": format(total_booked, ".0f"),
        "dentist_work_minutes": format(total_work, ".0f"),
        "dentist_utilization": rate(total_booked, total_shift),
        "work_utilization": rate(total_work, total_shift),
    }

    operations = {
        "revenue": amount_data(revenue), "net_received": amount_data(net_received),
        "material_cost": amount_data(material_cost), "operating_cost": amount_data(operating_cost),
        "net_profit": amount_data(net_profit), "profit_margin": rate(net_profit, revenue),
        "expense_categories": [
            {"category": category, "amount": amount_data(value)} for category, value in sorted(
                categories.items(), key=lambda item: item[1], reverse=True,
            )
        ],
        "expense_periods": sorted(periods_seen.values(), key=lambda row: (row["year"], row["quarter"])),
    }
    workload = {
        "total_minutes": format(sum(work_by_clinic.values(), ZERO), ".0f"),
        "total_hours": format(sum(work_by_clinic.values(), ZERO) / Decimal("60"), ".2f"),
        "dentists": workload_rows,
    }
    trend = {
        "granularity": granularity,
        "points": [{
            **point_data, "revenue": amount_data(point_data["revenue"]),
            "material_cost": amount_data(point_data["material_cost"]),
            "operating_cost": amount_data(point_data["operating_cost"]),
            "net_profit": amount_data(point_data["net_profit"]),
            "work_minutes": format(point_data["work_minutes"], ".0f"),
        } for point_data in points.values()],
    }
    visit_details = [{
        "visit_id": str(row["visit_id"]), "clinic_id": str(row["appointment__claim__clinic_id"]),
        "clinic_name": clinic_name(row["appointment__claim__clinic_id"]),
        "dentist_id": str(row["main_dentist_id"]), "dentist_name": dentist_name(row["main_dentist_id"]),
        "status": row["status"], "ended_at": row["ended_at"].isoformat(),
    } for row in visit_rows]
    work_details = [{
        "work_id": str(row["id"]), "visit_id": str(row["visit_id"]),
        "clinic_id": str(row["visit__appointment__claim__clinic_id"]),
        "clinic_name": clinic_name(row["visit__appointment__claim__clinic_id"]),
        "dentist_id": str(row["dentist_id"]), "dentist_name": dentist_name(row["dentist_id"]),
        "started_at": row["started_at"].isoformat(), "minutes": format(row["duration_minutes"], ".2f"),
    } for row in work_rows]
    profit_details = [{
        "clinic_id": row["clinic_id"], "clinic_name": row["clinic_name"],
        "revenue": row["revenue"], "material_cost": row["material_cost"],
        "operating_cost": row["operating_cost"], "net_profit": row["net_profit"],
    } for row in clinic_rows]
    details = {
        "revenue": revenue_rows, "material_cost": material_breakdown, "operating_cost": expense_breakdown,
        "net_profit": profit_details, "visits": visit_details, "work_minutes": work_details,
        "workload": workload_rows, "chair_utilization": chair_details, "dentist_utilization": dentist_utilization,
    }
    sources = {
        "operations": "按就诊结束日期统计应计收入与耗材成本；经营费用按登记季度的覆盖日数摊入所选期间。",
        "workload": "按牙医实际计时记录的开始时间汇总工作量。",
        "resources": "诊椅容量来自已发布班次的开放时段与可用牙椅数量；占用时段来自未取消的正式预约。",
    }
    return {"operations": operations, "workload": workload, "resources": resources,
            "clinics": clinic_rows, "trend": trend, "sources": sources}, details
