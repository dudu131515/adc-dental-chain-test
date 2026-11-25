from zoneinfo import ZoneInfo

from django.db import connection
from django.utils import timezone

from adc.reporting.models.periods import PerformancePeriod


BUSINESS_ZONE = ZoneInfo("Asia/Shanghai")


def lock_period_for_end(ended_at):
    if timezone.is_naive(ended_at):
        raise ValueError("The visit end must have an offset.")
    local_time = ended_at.astimezone(BUSINESS_ZONE)
    return lock_period(local_time.year, (local_time.month - 1) // 3 + 1)


def lock_period(year, quarter):
    if not connection.in_atomic_block:
        raise RuntimeError("The period lock must be acquired inside the business transaction.")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO performance_period (perf_year, perf_quarter, status)
            VALUES (%s, %s, 'OPEN')
            ON CONFLICT (perf_year, perf_quarter) DO NOTHING
            """,
            [year, quarter],
        )
    return PerformancePeriod.objects.select_for_update().get(perf_year=year, perf_quarter=quarter)
