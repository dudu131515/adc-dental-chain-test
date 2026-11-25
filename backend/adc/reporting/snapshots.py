from secrets import token_urlsafe

from django.core.cache import caches

from adc.common.http import ApiProblem, cursor_position, scoped_cursor
from adc.reporting.permissions import QUERY


SNAPSHOT_TTL_SECONDS = 300
DETAIL_PAGE_SIZE = 50


def binding(principal):
    scope = principal.clinic_scope(QUERY)
    return {"actor": str(principal.account_id), "scope": None if scope is None else sorted(scope)}


def store_snapshot(principal, metadata, details):
    token = token_urlsafe(24)
    caches["report_snapshots"].set(
        token, {"binding": binding(principal), "metadata": metadata, "details": dict(details)}, SNAPSHOT_TTL_SECONDS,
    )
    return token


def read_details(principal, token, metric, clinic, cursor):
    snapshot = caches["report_snapshots"].get(token)
    if snapshot is None:
        raise ApiProblem(409, "RESULT_EXPIRED", "本次报告查询已失效，请重新查询。")
    if snapshot["binding"] != binding(principal):
        raise ApiProblem(403, "PERMISSION_DENIED", "查询权限已变化，请重新查询。")
    metadata = snapshot["metadata"]
    if clinic and clinic not in metadata["scope"]["clinic_ids"]:
        raise ApiProblem(403, "PERMISSION_DENIED", "该门店不在本次查询范围内。")
    rows = snapshot["details"].get(metric)
    if rows is None:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择本报告中的指标。")
    if clinic:
        rows = [row for row in rows if row.get("clinic_id") == clinic]
    key = {"token": token, "metric": metric, "clinic": clinic}
    offset = cursor_position(cursor, key) if cursor else 0
    end = offset + DETAIL_PAGE_SIZE
    return {
        **metadata, "metric": metric, "items": rows[offset:end], "total": len(rows),
        "next_cursor": scoped_cursor(key, end) if end < len(rows) else None,
    }
