from collections import Counter

from adc.scheduling.models import DentalChair, DentalChairUnavailability


def unavailable_chair_periods(clinic_id, start, end):
    """List intervals with zero operable chairs. Booking still checks type and concurrent claims."""
    chairs = DentalChair.objects.filter(clinic_id=clinic_id, status="AVAILABLE", clinic__status="ACTIVE")
    chair_count = chairs.count()
    if not chair_count:
        return [{"start_at": start.isoformat(), "end_at": end.isoformat()}]
    changes = Counter()
    for first, last in DentalChairUnavailability.objects.filter(
        chair__in=chairs, start_at__lt=end, end_at__gt=start,
    ).values_list("start_at", "end_at"):
        changes[max(first, start)] += 1
        changes[min(last, end)] -= 1
    intervals, blocked, interval_start = [], 0, None
    for timestamp, delta in sorted(changes.items()):
        blocked += delta
        if blocked == chair_count and interval_start is None:
            interval_start = timestamp
        elif blocked < chair_count and interval_start is not None:
            intervals.append({"start_at": interval_start.isoformat(), "end_at": timestamp.isoformat()})
            interval_start = None
    return intervals
