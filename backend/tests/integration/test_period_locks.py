from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier

from django.db import connections, transaction
from django.test import TransactionTestCase


class QuarterLockTests(TransactionTestCase):
    def test_local_quarter_uses_one_row_when_first_written_by_two_transactions(self):
        from adc.reporting.models.periods import PerformancePeriod
        from adc.reporting.period_locks import lock_period_for_end

        instant = datetime(2032, 12, 31, 16, 20, tzinfo=timezone.utc)
        ready = Barrier(2, timeout=5)

        def writer():
            try:
                ready.wait()
                with transaction.atomic():
                    period = lock_period_for_end(instant)
                    return period.pk, period.perf_year, period.perf_quarter, period.status
            finally:
                connections.close_all()

        try:
            with ThreadPoolExecutor(max_workers=2) as workers:
                a, b = [workers.submit(writer) for _ in range(2)]
                first, second = a.result(timeout=10), b.result(timeout=10)
            self.assertEqual(first, second)
            self.assertEqual(first[1:], (2033, 1, "OPEN"))
            self.assertEqual(PerformancePeriod.objects.filter(perf_year=2033, perf_quarter=1).count(), 1)
        finally:
            PerformancePeriod.objects.filter(perf_year=2033, perf_quarter=1).delete()

    def test_period_initialization_rolls_back_with_its_business_transaction(self):
        from adc.reporting.models.periods import PerformancePeriod
        from adc.reporting.period_locks import lock_period_for_end

        instant = datetime(2034, 3, 31, 15, 59, tzinfo=timezone.utc)
        with transaction.atomic():
            period = lock_period_for_end(instant)
            self.assertEqual((period.perf_year, period.perf_quarter), (2034, 1))
            transaction.set_rollback(True)
        self.assertFalse(PerformancePeriod.objects.filter(perf_year=2034).exists())
