from decimal import Decimal

from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.clinical.material_costs import legacy_cost_versions, legacy_entries, managed_reference
from adc.clinical.models import Material, MaterialCost
from adc.clinical.treatment_service import save_decision, save_item
from adc.clinical.visit_api import own_visit
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values


class Decision(serializers.Serializer):
    treatment_type_id = ID()
    decision = serializers.ChoiceField(choices=("ACCEPTED", "DECLINED"))
    evidence_ref = serializers.CharField()


class Usage(serializers.Serializer):
    material_id = ID()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.000"))
    cost_evidence_ref = serializers.CharField()


class Item(serializers.Serializer):
    treatment_type_id = ID()
    units = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=Decimal("0.001"))
    tooth_code = serializers.CharField(max_length=20, required=False)
    is_additional = serializers.BooleanField(required=False)
    decision_id = ID(required=False)
    performed_at = serializers.DateTimeField(required=False)
    materials = Usage(many=True, required=False)


@api_view(["GET"])
def materials(request):
    request.user.require("DENTIST")
    catalog = list(Material.objects.filter(status="ACTIVE").order_by("material_code"))
    managed = {}
    for cost in MaterialCost.objects.filter(material__status="ACTIVE").order_by("-effective_from", "pk"):
        managed.setdefault(cost.material_id, []).append(managed_reference(cost.pk))
    try:
        legacy = legacy_cost_versions()
    except ApiProblem:
        if not managed:
            raise
        legacy = {}
    return success({
        "items": [
            {
                "material_id": str(row.pk), "material_name": row.material_name, "standard_unit": row.standard_unit,
                "cost_references": [
                    *managed.get(row.pk, []),
                    *(entry["reference"] for entry in legacy_entries(legacy, row) if isinstance(entry.get("reference"), str)),
                ],
            }
            for row in catalog
        ],
        "next_cursor": None,
    })


@api_view(["POST"])
def additional(request, pk):
    visit = own_visit(request, pk)
    fields = values(Decision, request.data)
    operation = OperationKey.from_request(request, command="additional_decision", target={"visit_id": pk})
    saved, created = save_decision(request.user, visit, fields, operation)
    return success({
        "decision_id": str(saved.pk), "treatment_type_id": saved.after_value["treatment_type_id"],
        "decision": saved.after_value["decision"],
    }, status_code=201 if created else 200)


@api_view(["POST"])
def treatment_item(request, pk):
    visit = own_visit(request, pk)
    fields = values(Item, request.data)
    operation = OperationKey.from_request(request, command="record_treatment", target={"visit_id": pk})
    item, created = save_item(request.user, visit, fields, operation)
    return success({
        "item_id": str(item.pk), "treatment_type_id": str(item.treatment_type_id),
        "units": format(item.units, ".3f"), "unit_price": format(item.unit_price_snapshot, ".2f"),
        "amount": format(item.amount, ".2f"), "is_additional": item.is_additional,
    }, status_code=201 if created else 200)


urlpatterns = [
    path("clinical/materials", materials),
    path("visits/<int:pk>/additional-decisions", additional),
    path("visits/<int:pk>/treatment-items", treatment_item),
]
