from datetime import date
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path

from django.conf import settings
from django.db.models import Q

from adc.clinical.models import MaterialCost
from adc.common.http import ApiProblem


def effective_material_costs(day):
    return MaterialCost.objects.filter(effective_from__lte=day).filter(
        Q(effective_to__isnull=True) | Q(effective_to__gt=day),
    )


def managed_reference(cost_id):
    return f"material-cost:{cost_id}"


def missing_cost():
    return ApiProblem(409, "EVIDENCE_REQUIRED", "耗材缺少本次实施日期的唯一有效成本凭据。")


def legacy_cost_versions():
    path = settings.ADC_MATERIAL_COSTS_PATH
    if not path:
        return {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise TypeError
        return data
    except (OSError, ValueError, TypeError):
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "耗材凭据配置无法读取。") from None


def legacy_entries(versions, material):
    sources = versions.get(material.material_code, [])
    return [entry for entry in sources if isinstance(entry, dict)] if isinstance(sources, list) else []


def legacy_amounts(versions, material, day, reference=None):
    for source in legacy_entries(versions, material):
        try:
            if reference is not None and source.get("reference") != reference:
                continue
            if date.fromisoformat(source["effective_from"]) > day:
                continue
            if source.get("effective_to") and day >= date.fromisoformat(source["effective_to"]):
                continue
            amount = Decimal(source["unit_cost"])
            if amount.is_finite() and 0 <= amount <= Decimal("9999999999.99") and amount == amount.quantize(Decimal("0.01")):
                yield amount
        except (KeyError, TypeError, ValueError, InvalidOperation):
            continue


def legacy_current_amount(versions, material, day):
    amounts = set(legacy_amounts(versions, material, day))
    return amounts.pop() if len(amounts) == 1 else None
