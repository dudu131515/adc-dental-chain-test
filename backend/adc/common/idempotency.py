from dataclasses import dataclass
from hashlib import sha256
import json

from adc.common.http import ApiProblem
from adc.identity.models import AuditLog


def canonical_digest(data):
    encoded = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class OperationKey:
    account_id: int
    command: str
    target: dict
    key: str

    @classmethod
    def from_request(cls, request, *, command, target):
        key = request.headers.get("Idempotency-Key", "")
        if not key or len(key) > 100 or not key.isascii() or any(not (33 <= ord(c) <= 126) for c in key):
            raise ApiProblem(
                400, "VALIDATION_ERROR", "缺少有效的办理标识。",
                field_errors={"idempotency_key": "请使用同一个有效的办理标识重试。"},
            )
        return cls(request.user.account_id, command, target, key)

    @property
    def scope_digest(self):
        return canonical_digest([self.account_id, self.command, self.target, self.key])

    def result_id(self, normalized_payload=None):
        event = AuditLog.objects.filter(
            account_id=self.account_id, action="IDEMPOTENCY_RESULT", target_type=self.command,
            after_value__scope_digest=self.scope_digest,
        ).order_by("-id").first()
        if event is None:
            return None
        if normalized_payload is not None and event.after_value["payload_digest"] != canonical_digest(normalized_payload):
            raise ApiProblem(409, "IDEMPOTENCY_CONFLICT", "办理标识已经用于不同的内容。")
        return event.target_id

    def record_result(self, result_id, normalized_payload):
        # The caller serializes operations on its business aggregate and commits both together.
        return AuditLog.objects.create(
            account_id=self.account_id,
            action="IDEMPOTENCY_RESULT",
            target_type=self.command,
            target_id=result_id,
            after_value={
                "version": 1,
                "scope_digest": self.scope_digest,
                "payload_digest": canonical_digest(normalized_payload),
            },
        )
