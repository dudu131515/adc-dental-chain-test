from django.db import IntegrityError, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404

from adc.catalog.models import TreatmentPrice, TreatmentType
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.scheduling.models import DentalChair, Qualification


def treatment_projection(model, *, booking):
    common = {
        "treatment_type_id": str(model.pk),
        "treatment_name": model.treatment_name,
        "default_slot_minutes": model.default_slot_minutes,
        "required_chair_kind": model.required_chair_kind,
    }
    if booking:
        return common
    return {
        **common,
        "treatment_code": model.treatment_code,
        "standard_unit": model.standard_unit,
        "required_qualification_id": str(model.required_qualification_id) if model.required_qualification_id else None,
        "active": model.active,
    }


def price_projection(price):
    return {
        "price_id": str(price.pk),
        "treatment_type_id": str(price.treatment_type_id),
        "unit_price": format(price.unit_price, ".2f"),
        "effective_from": price.effective_from.isoformat(),
        "effective_to": price.effective_to.isoformat() if price.effective_to else None,
    }


def price_on_local_date(treatment_id, date):
    return TreatmentPrice.objects.filter(
        treatment_type_id=treatment_id, effective_from__lte=date,
    ).filter(Q(effective_to__isnull=True) | Q(effective_to__gt=date)).first()


def validate_standard(data):
    qualification = data.get("required_qualification_id")
    chair_kind = data.get("required_chair_kind")
    errors = {}
    if qualification and not Qualification.objects.filter(pk=qualification).exists():
        errors["required_qualification_id"] = "请选择有效的资格。"
    if chair_kind and not DentalChair.objects.filter(chair_kind=chair_kind).exists():
        errors["required_chair_kind"] = "请选择已配置的椅型。"
    if errors:
        raise ApiProblem(400, "VALIDATION_ERROR", "请检查项目标准。", field_errors=errors)


def save_treatment(principal, data, treatment_id=None):
    try:
        with transaction.atomic():
            validate_standard(data)
            if treatment_id is None:
                model = TreatmentType.objects.create(**data)
                before = None
            else:
                model = get_object_or_404(TreatmentType.objects.select_for_update(), pk=treatment_id)
                before = treatment_projection(model, booking=False)
                for field, value in data.items():
                    setattr(model, field, value)
                model.save(update_fields=tuple(data))
            after = treatment_projection(model, booking=False)
            record_event(
                account_id=principal.account_id, action="TREATMENT_STANDARD_SAVED",
                target_type="treatment_type", target_id=model.pk,
                visible_fields=after.keys(), before=before, after=after,
            )
            return model
    except IntegrityError as error:
        name = getattr(getattr(error.__cause__, "diag", None), "constraint_name", "")
        if name == "treatment_type_treatment_code_key":
            raise ApiProblem(
                409, "RESOURCE_CONFLICT", "项目编码已存在。",
                field_errors={"treatment_code": "请使用唯一编码。"},
            ) from None
        raise


def effective_range_check(treatment_id, start, end):
    future_end = Q(effective_to__isnull=True) | Q(effective_to__gt=start)
    active_ranges = TreatmentPrice.objects.filter(future_end, treatment_type_id=treatment_id)
    if end is not None:
        active_ranges = active_ranges.filter(effective_from__lt=end)
    if active_ranges.exists():
        raise ApiProblem(409, "RESOURCE_CONFLICT", "同一项目的价格生效区间不能重叠。")


def add_price(principal, treatment_id, data, replace_price_id=None, replace_effective_to=None):
    with transaction.atomic():
        treatment = get_object_or_404(TreatmentType.objects.select_for_update(), pk=treatment_id)
        before = None
        if replace_price_id is not None:
            old = get_object_or_404(TreatmentPrice, treatment_type=treatment, pk=replace_price_id)
            if replace_effective_to <= old.effective_from or (
                old.effective_to is not None and replace_effective_to > old.effective_to
            ):
                raise ApiProblem(409, "RESOURCE_CONFLICT", "请选择原价格版本范围内的有效结束日期。")
            before = price_projection(old)
            old.effective_to = replace_effective_to
            old.save(update_fields=("effective_to",))
        effective_range_check(treatment_id, data["effective_from"], data.get("effective_to"))
        price = TreatmentPrice.objects.create(treatment_type=treatment, **data)
        summary = price_projection(price)
        record_event(
            account_id=principal.account_id, action="TREATMENT_PRICE_VERSION_CREATED", target_type="treatment_price",
            target_id=price.pk, visible_fields=summary.keys(), before=before, after=summary,
        )
        return price
