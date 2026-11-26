from collections import defaultdict
from datetime import timedelta

from adc.identity.models import AuditLog
from adc.scheduling.models import Shift, ShiftDemand
from adc.scheduling.shift_batch import ACTIVE_SHIFT_STATES
from adc.scheduling.shift_service import qualified


TRANSFER_TIME = timedelta(minutes=60)


def minimum_coverage(demand, shifts):
    events = defaultdict(list)
    events[demand.start_at]
    for shift in shifts:
        if shift.end_at <= demand.start_at or shift.start_at >= demand.end_at:
            continue
        if not qualified(shift.dentist_id, demand.required_qualification_id, shift.start_at, shift.end_at):
            continue
        events[max(shift.start_at, demand.start_at)].append((shift.dentist_id, 1))
        events[min(shift.end_at, demand.end_at)].append((shift.dentist_id, -1))

    active = defaultdict(int)
    minimum = demand.required_count
    for stamp, changes in sorted(events.items()):
        if stamp == demand.end_at:
            break
        for dentist_id, change in changes:
            active[dentist_id] += change
            if active[dentist_id] == 0:
                del active[dentist_id]
        minimum = min(minimum, len(active))
    return minimum


def staffing_shortages(principal, start, end, clinic_id):
    scope = principal.clinic_scope("HQ_SCHEDULER", "CLINIC_MANAGER")
    demands = ShiftDemand.objects.filter(end_at__gt=start, start_at__lt=end, clinic__status="ACTIVE")
    if scope is not None:
        demands = demands.filter(clinic_id__in=scope)
    if clinic_id is not None:
        demands = demands.filter(clinic_id=clinic_id)
    demands = list(demands.order_by("start_at", "pk"))
    if not demands:
        return []
    coverage = defaultdict(list)
    for shift in Shift.objects.filter(
        clinic_id__in={row.clinic_id for row in demands},
        status="PUBLISHED", dentist__status="ACTIVE",
        end_at__gt=min(row.start_at for row in demands), start_at__lt=max(row.end_at for row in demands),
    ):
        coverage[shift.clinic_id].append(shift)

    shortages = []
    for demand in demands:
        count = minimum_coverage(demand, coverage[demand.clinic_id])
        if count < demand.required_count:
            shortages.append({
                "demand_id": str(demand.pk), "clinic_id": str(demand.clinic_id),
                "required_qualification_id": str(demand.required_qualification_id) if demand.required_qualification_id else None,
                "start_at": demand.start_at.isoformat(), "end_at": demand.end_at.isoformat(),
                "required_count": demand.required_count, "assigned_count": count,
                "missing_count": demand.required_count - count,
            })
    return shortages


def shift_conflicts(visible_query, visible_rows, start, end):
    visible_ids = {row.pk for row in visible_rows if row.status in ACTIVE_SHIFT_STATES}
    if not visible_ids:
        return []
    by_dentist = defaultdict(list)
    for shift in visible_query.filter(
        dentist_id__in={row.dentist_id for row in visible_rows},
        status__in=ACTIVE_SHIFT_STATES, end_at__gt=start - TRANSFER_TIME, start_at__lt=end + TRANSFER_TIME,
    ).order_by("start_at", "pk"):
        by_dentist[shift.dentist_id].append(shift)

    conflicts = []
    for shifts in by_dentist.values():
        for index, first in enumerate(shifts):
            for second in shifts[index + 1:]:
                gap = second.start_at - first.end_at
                if gap >= TRANSFER_TIME:
                    break
                if first.pk not in visible_ids and second.pk not in visible_ids:
                    continue
                cross_clinic = first.clinic_id != second.clinic_id
                if gap < timedelta(0):
                    code = "CROSS_CLINIC_OVERLAP" if cross_clinic else "SHIFT_OVERLAP"
                elif cross_clinic:
                    code = "CROSS_CLINIC_TRAVEL"
                else:
                    continue
                conflicts.append({
                    "code": code, "dentist_id": str(first.dentist_id),
                    "shift_ids": [str(first.pk), str(second.pk)],
                    "clinic_ids": [str(first.clinic_id), str(second.clinic_id)],
                })
    return conflicts


def rejection_reasons(shifts):
    rejected = [row.pk for row in shifts if row.status == "REJECTED"]
    events = AuditLog.objects.filter(
        action="SHIFT_CHANGED", target_type="shift", target_id__in=rejected,
        after_value__status="REJECTED",
    ).order_by("pk")
    return {row.target_id: row.after_value.get("reason") for row in events}
