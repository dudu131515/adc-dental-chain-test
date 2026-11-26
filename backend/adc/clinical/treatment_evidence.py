from adc.identity.models import AuditLog


def name_snapshots(items):
    ids = [item.pk for item in items]
    audit = AuditLog.objects.filter(
        action="TREATMENT_ITEM_RECORDED", target_type="treatment_item", target_id__in=ids,
    ).order_by("id")
    return {row.target_id: row.after_value.get("treatment_name") for row in audit}
