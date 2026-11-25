from pathlib import Path

from django.core.management import call_command
from django.db import connections, transaction
from django.test.runner import DiscoverRunner


DESIGN_SQL = Path(__file__).resolve().parents[2] / "usecase" / "ADC_PostgreSQL_设计与统计.sql"


class ADCTestRunner(DiscoverRunner):
    def build_suite(self, test_labels=None, **kwargs):
        return super().build_suite(test_labels or ["tests"], **kwargs)

    def setup_databases(self, **kwargs):
        aliases = kwargs.get("aliases")
        state = super().setup_databases(**kwargs)
        try:
            if aliases is None or "default" in aliases:
                connection = connections["default"]
                with transaction.atomic(using="default"), connection.cursor() as cursor:
                    cursor.execute("SELECT to_regclass('public.appointment')")
                    if cursor.fetchone()[0] is None:
                        cursor.execute(DESIGN_SQL.read_text(encoding="utf-8-sig"))
            if aliases is None or "runtime" in aliases:
                call_command("createcachetable", "adc_report_snapshot", database="runtime", verbosity=0)
        except Exception:
            self.teardown_databases(state)
            raise
        return state
