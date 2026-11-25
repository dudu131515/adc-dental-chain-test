from pathlib import Path

from django.core import serializers
from django.core.management.color import no_style
from django.db import connection, transaction


SYNTHETIC_BASE = Path(__file__).with_name("synthetic_base.json")


def load_synthetic_base():
    # Django loaddata respects migration ownership and skips ADC unmanaged business tables.
    models = set()
    with transaction.atomic(), SYNTHETIC_BASE.open(encoding="utf-8") as source:
        for row in serializers.deserialize("json", source):
            row.save(using="default")
            models.add(type(row.object))
        with connection.cursor() as cursor:
            for statement in connection.ops.sequence_reset_sql(no_style(), models):
                cursor.execute(statement)
