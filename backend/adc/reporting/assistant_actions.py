from datetime import timedelta
from secrets import token_urlsafe

from django.db import connection, transaction
from django.utils.timezone import now

from adc.common.http import ApiProblem
from adc.common.idempotency import canonical_digest
from adc.identity.audit import record_event
from adc.identity.models import AuditLog
from adc.reporting.snapshots import binding


ACTION = "ASSISTANT_ANALYSIS_ACCEPTED"
PENDING_WINDOW = timedelta(minutes=2)


def accepted_action(operation):
    return AuditLog.objects.filter(
        account_id=operation.account_id, action=ACTION, target_type=operation.command,
        after_value__operation_digest=operation.scope_digest,
    ).first()


def claim_analysis(principal, operation, selection):
    operation_digest = operation.scope_digest
    current_binding = canonical_digest(binding(principal))
    payload_digest = canonical_digest(selection)
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [operation_digest])
        previous = accepted_action(operation)
        if previous is not None:
            require_action_scope(principal, previous)
            if previous.after_value["payload_digest"] != payload_digest:
                raise ApiProblem(409, "IDEMPOTENCY_CONFLICT", "分析标识已用于不同的筛选条件。")
            return previous, False

        accepted = record_event(
            account_id=operation.account_id, action=ACTION, target_type=operation.command, target_id=None,
            visible_fields=("operation_digest", "binding_digest", "payload_digest", "analysis_id"),
            after={
                "operation_digest": operation_digest, "binding_digest": current_binding,
                "payload_digest": payload_digest, "analysis_id": token_urlsafe(24),
            },
        )
        return accepted, True


def require_action_scope(principal, accepted):
    if accepted.after_value["binding_digest"] != canonical_digest(binding(principal)):
        raise ApiProblem(403, "PERMISSION_DENIED", "经营查询授权已变化，请重新分析。")


def require_action_result(accepted):
    if now() - accepted.occurred_at < PENDING_WINDOW:
        raise ApiProblem(409, "RESULT_PENDING", "原分析正在处理，请稍后核对原分析结果。")
    raise ApiProblem(409, "RESULT_EXPIRED", "原分析结果无法恢复，请重新提交分析。")
