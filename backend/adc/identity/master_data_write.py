import json

from django.core.serializers.json import DjangoJSONEncoder
from django.db import DatabaseError, connection

from adc.common.http import ApiProblem


def write_master_row(user, model, data, *, pk=None):
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.adc_write_master_data(%s, %s, %s, %s::jsonb)",
                [user.account_id, model._meta.db_table, pk, json.dumps(data, cls=DjangoJSONEncoder)],
            )
            saved_id = cursor.fetchone()[0]
    except DatabaseError as error:
        if getattr(error.__cause__, "sqlstate", None) == "42501":
            raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能办理此资料变更。") from None
        raise
    if saved_id is None:
        raise ApiProblem(404, "NOT_FOUND", "找不到可变更的资料。")
    return model.objects.get(pk=saved_id)


def lock_master_rows(model, ids):
    # Reference tables without UPDATE access use the same advisory lock for read and write commands.
    with connection.cursor() as cursor:
        for pk in sorted(set(ids)):
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                [f"adc-master:{model._meta.db_table}:{pk}"],
            )
