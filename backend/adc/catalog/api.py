from decimal import Decimal

from django.db.models import OuterRef, Q, Subquery
from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.catalog.models import TreatmentPrice, TreatmentType
from adc.catalog.services import add_price, price_projection, save_treatment, treatment_projection
from adc.common.http import ApiProblem, success
from adc.common.serializers import ID, values


class Standard(serializers.Serializer):
    treatment_code = serializers.CharField(max_length=50)
    treatment_name = serializers.CharField(max_length=160)
    standard_unit = serializers.CharField(max_length=50)
    required_qualification_id = ID(required=False, allow_null=True)
    default_slot_minutes = serializers.IntegerField(min_value=1, max_value=2**31 - 1, required=False, allow_null=True)
    required_chair_kind = serializers.CharField(max_length=40, required=False, allow_null=True)
    active = serializers.BooleanField(required=False)


class Price(serializers.Serializer):
    unit_price = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal(0))
    effective_from = serializers.DateField()
    effective_to = serializers.DateField(required=False, allow_null=True)
    replace_price_id = ID(required=False)
    replace_effective_to = serializers.DateField(required=False)

    def validate(self, data):
        end = data.get("effective_to")
        if end and end <= data["effective_from"]:
            raise serializers.ValidationError({"effective_to": "结束日期须晚于生效日期。"})
        if ("replace_price_id" in data) != ("replace_effective_to" in data):
            raise serializers.ValidationError({"replace_price_id": "请同时选择原价格版本及结束日期。"})
        return data


def require_catalog_read(principal, *, booking=False):
    if booking and principal.channel == "patient":
        return
    if not any(principal.allows(role) for role in ("FRONT_DESK", "DENTIST", "HQ_CATALOG")):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能读取项目价格资料。")


@api_view(["GET", "POST"])
def treatments(request):
    if request.method == "POST":
        request.user.require("HQ_CATALOG")
        treatment = save_treatment(request.user, values(Standard, request.data))
        return success(treatment_projection(treatment, booking=False), status_code=201)
    require_catalog_read(request.user, booking=True)
    booking = request.user.channel == "patient"
    query = TreatmentType.objects.all()
    if booking:
        query = query.filter(active=True)
    else:
        today = timezone.localdate()
        effective_price = TreatmentPrice.objects.filter(
            treatment_type_id=OuterRef("pk"), effective_from__lte=today,
        ).filter(Q(effective_to__isnull=True) | Q(effective_to__gt=today))
        query = query.annotate(current_unit_price=Subquery(effective_price.values("unit_price")[:1]))
    items = []
    for model in query.order_by("treatment_code"):
        projection = treatment_projection(model, booking=booking)
        if not booking:
            current_price = model.current_unit_price
            projection["current_unit_price"] = format(current_price, ".2f") if current_price is not None else None
        items.append(projection)
    return success({
        "items": items,
        "next_cursor": None,
    })


@api_view(["PATCH"])
def update_treatment(request, pk):
    request.user.require("HQ_CATALOG")
    data = values(Standard, request.data, partial=True)
    if not data:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择需要修改的项目字段。")
    model = save_treatment(request.user, data, treatment_id=pk)
    return success(treatment_projection(model, booking=False))


@api_view(["GET", "POST"])
def prices(request, pk):
    if request.method == "GET":
        require_catalog_read(request.user)
        treatment = get_object_or_404(TreatmentType, pk=pk)
        versions = TreatmentPrice.objects.filter(treatment_type=treatment).order_by("-effective_from", "pk")
        return success({"items": [price_projection(version) for version in versions], "next_cursor": None})
    request.user.require("HQ_CATALOG")
    data = values(Price, request.data)
    previous_price = data.pop("replace_price_id", None)
    previous_end = data.pop("replace_effective_to", None)
    price = add_price(request.user, pk, data, previous_price, previous_end)
    return success(price_projection(price), status_code=201)


urlpatterns = [
    path("catalog/treatments", treatments),
    path("catalog/treatments/<int:pk>", update_treatment),
    path("catalog/treatments/<int:pk>/prices", prices),
]
