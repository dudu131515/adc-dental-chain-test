from adc.identity.models import AuditLog


def record_event(*, account_id, action, target_type, target_id, visible_fields, before=None, after=None):
    """Store the event's minimum projection in the same business transaction as its change."""
    def projection(value):
        if value is None:
            return None
        return {"version": 1, **{key: value[key] for key in visible_fields if key in value}}

    return AuditLog.objects.create(
        account_id=account_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        before_value=projection(before),
        after_value=projection(after),
    )
