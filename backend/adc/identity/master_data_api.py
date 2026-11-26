from dataclasses import replace
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import OuterRef, Q, Subquery
from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.chair_capacity import ClinicCapacity, connected_requirements, has_feasible_assignment, load_capacity
from adc.clinical.material_costs import effective_material_costs, legacy_cost_versions, legacy_current_amount
from adc.clinical.models import ChairUsage, Material, MaterialCost
from adc.common.http import ApiProblem, success, translate_integrity_error
from adc.common.serializers import ID, values
from adc.identity.admin_api import clinic_choices, clinic_summary
from adc.identity.audit import record_event
from adc.identity.master_data_write import lock_master_rows, write_master_row
from adc.identity.models import Clinic, Employee, EmployeeRole
from adc.identity.permissions import ACCESS_ADMIN_ROLE
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.models import DentalChair, DentalChairUnavailability, EmployeeQualification, Qualification


class QualificationStandard(serializers.Serializer):
    qualification_code = serializers.CharField(max_length=50)
    qualification_name = serializers.CharField(max_length=120)


class DentistCredential(serializers.Serializer):
    employee_id = ID()
    qualification_id = ID()
    certificate_no = serializers.CharField(max_length=80, required=False, allow_null=True, allow_blank=True)
    valid_from = serializers.DateField(required=False, allow_null=True)
    valid_until = serializers.DateField(required=False, allow_null=True)


class ChairRecord(serializers.Serializer):
    clinic_id = ID()
    chair_no = serializers.CharField(max_length=40)
    chair_kind = serializers.CharField(max_length=40, required=False)
    status = serializers.ChoiceField(choices=("AVAILABLE", "INACTIVE"), required=False)


class MaterialStandard(serializers.Serializer):
    material_code = serializers.CharField(max_length=40)
    material_name = serializers.CharField(max_length=140)
    standard_unit = serializers.CharField(max_length=50)
    status = serializers.ChoiceField(choices=("ACTIVE", "INACTIVE"), required=False)


class CostVersion(serializers.Serializer):
    unit_cost = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0"))
    effective_from = serializers.DateField()
    effective_to = serializers.DateField(required=False, allow_null=True)
    replace_cost_id = ID(required=False)
    replace_effective_to = serializers.DateField(required=False)

    def validate(self, fields):
        end = fields.get("effective_to")
        if end and end <= fields["effective_from"]:
            raise serializers.ValidationError({"effective_to": "结束日期须晚于生效日期。"})
        if ("replace_cost_id" in fields) != ("replace_effective_to" in fields):
            raise serializers.ValidationError({"replace_cost_id": "请同时选择原成本版本及结束日期。"})
        if fields.get("replace_effective_to", fields["effective_from"]) != fields["effective_from"]:
            raise serializers.ValidationError({"replace_effective_to": "原成本截止日须与新成本生效日相同。"})
        return fields


def require_chain_master_access(principal):
    if principal.allows(ACCESS_ADMIN_ROLE):
        return
    if principal.allows("HQ_CATALOG") and principal.clinic_scope("HQ_CATALOG") is None:
        return
    raise ApiProblem(403, "PERMISSION_DENIED", "当前账号缺少全连锁基础资料权限。")


def update_fields(serializer, payload):
    data = values(serializer, payload, partial=True)
    if not data:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择需要修改的资料字段。")
    return data


def record_change(user, action, row, after, before=None):
    record_event(
        account_id=user.account_id, action=action, target_type=row._meta.db_table,
        target_id=row.pk, visible_fields=after.keys(), before=before, after=after,
    )


def save_standard(user, model, data, project, action, constraints, pk=None):
    try:
        with transaction.atomic():
            if pk is None:
                row = write_master_row(user, model, data)
                before = None
            else:
                lock_master_rows(model, [pk])
                row = get_object_or_404(model, pk=pk)
                before = project(row)
                row = write_master_row(user, model, data, pk=pk)
            after = project(row)
            record_change(user, action, row, after, before)
            return after
    except IntegrityError as error:
        raise translate_integrity_error(error, constraints)


def qualification_data(row):
    return {
        "qualification_id": str(row.pk), "qualification_code": row.qualification_code,
        "qualification_name": row.qualification_name,
    }


def qualification_choices():
    return [qualification_data(row) for row in Qualification.objects.order_by("qualification_code")]


def save_qualification(user, data, pk=None):
    return save_standard(
        user, Qualification, data, qualification_data, "QUALIFICATION_STANDARD_SAVED",
        {"qualification_qualification_code_key": ("RESOURCE_CONFLICT", "资质编号已存在。")}, pk,
    )


@api_view(["GET", "POST"])
def qualifications(request):
    require_chain_master_access(request.user)
    if request.method == "POST":
        return success(save_qualification(request.user, values(QualificationStandard, request.data)), status_code=201)
    return success({"items": qualification_choices()})


@api_view(["PATCH"])
def update_qualification(request, pk):
    require_chain_master_access(request.user)
    return success(save_qualification(request.user, update_fields(QualificationStandard, request.data), pk))


def dentist_choices():
    grants = EmployeeRole.objects.filter(role__role_code="DENTIST", scope_clinic__isnull=False).values("employee_id")
    return Employee.objects.filter(Q(job_code=Employee.Job.DENTIST) | Q(pk__in=grants), status="ACTIVE")


def credential_data(row):
    return {
        "credential_id": str(row.pk), "employee_id": str(row.employee_id), "employee_name": row.employee.full_name,
        "employee_no": row.employee.employee_no, **qualification_data(row.qualification),
        "certificate_no": row.certificate_no,
        "valid_from": row.valid_from.isoformat() if row.valid_from else None,
        "valid_until": row.valid_until.isoformat() if row.valid_until else None,
    }


def save_credential(user, data, pk=None):
    with transaction.atomic():
        row = get_object_or_404(EmployeeQualification, pk=pk) if pk is not None else None
        dentist_id = row.employee_id if row else data["employee_id"]
        get_object_or_404(Employee.objects.select_for_update(), pk=dentist_id)
        if row:
            row = EmployeeQualification.objects.get(pk=pk)
            for field in ("employee_id", "qualification_id"):
                if data.pop(field, getattr(row, field)) != getattr(row, field):
                    raise ApiProblem(400, "VALIDATION_ERROR", "请为其他牙医或资质新建记录。")
            before = credential_data(row)
        else:
            if not dentist_choices().filter(pk=dentist_id).exists():
                raise ApiProblem(400, "VALIDATION_ERROR", "请选择在职牙医。")
            get_object_or_404(Qualification, pk=data["qualification_id"])
            row = EmployeeQualification(employee_id=dentist_id, qualification_id=data["qualification_id"])
            before = None
        details = {field: data.get(field, getattr(row, field)) for field in ("certificate_no", "valid_from", "valid_until")}
        start, end = details["valid_from"], details["valid_until"]
        if start and end and end < start:
            raise ApiProblem(400, "VALIDATION_ERROR", "有效截止日不得早于起始日。", field_errors={"valid_until": "请核对日期。"})
        if EmployeeQualification.objects.filter(
            employee_id=dentist_id, qualification_id=row.qualification_id, **details,
        ).exclude(pk=pk).exists():
            raise ApiProblem(409, "RESOURCE_CONFLICT", "该牙医已有相同的资质记录。")
        if pk is None:
            row = write_master_row(user, EmployeeQualification, data)
        elif data:
            row = write_master_row(user, EmployeeQualification, data, pk=pk)
        after = credential_data(row)
        record_change(user, "DENTIST_QUALIFICATION_SAVED", row, after, before)
        return after


@api_view(["GET", "POST"])
def dentist_qualifications(request):
    require_chain_master_access(request.user)
    if request.method == "POST":
        return success(save_credential(request.user, values(DentistCredential, request.data)), status_code=201)
    rows = EmployeeQualification.objects.select_related("employee", "qualification").order_by("employee__employee_no", "pk")
    return success({
        "items": [credential_data(row) for row in rows],
        "dentists": [{"employee_id": str(row.pk), "full_name": row.full_name, "employee_no": row.employee_no}
                     for row in dentist_choices().order_by("employee_no")],
        "qualifications": qualification_choices(),
    })


@api_view(["PATCH"])
def update_dentist_qualification(request, pk):
    require_chain_master_access(request.user)
    return success(save_credential(request.user, update_fields(DentistCredential, request.data), pk))


def chair_data(row):
    return {
        "chair_id": str(row.pk), "clinic_id": str(row.clinic_id), "clinic_name": row.clinic.clinic_name,
        "chair_no": row.chair_no, "chair_kind": row.chair_kind, "status": row.status,
    }


def check_capacity_change(row, old_clinic, prior, now):
    chairs = [
        replace(chair, kind=row.chair_kind) if chair.id == row.pk else chair
        for chair in prior.chairs
        if chair.id != row.pk or (row.status == "AVAILABLE" and row.clinic_id == old_clinic)
    ]
    if chairs == prior.chairs:
        return
    current = ClinicCapacity(chairs, prior.requirements)
    checked = set()
    remaining = [item for item in prior.requirements if item.end > now]
    for item in remaining:
        if item.claim_id in checked:
            continue
        group = connected_requirements(item, [other for other in remaining if other is not item])
        checked.update(candidate.claim_id for candidate in group)
        if has_feasible_assignment(prior.chairs, group) and not has_feasible_assignment(current.chairs, group):
            raise ApiProblem(409, "RESOURCE_CONFLICT", "此变更会使已有预约或占位缺少适配牙椅。")


def save_chair(user, data, pk=None):
    try:
        with transaction.atomic():
            first = get_object_or_404(DentalChair, pk=pk) if pk is not None else None
            old_clinic = first.clinic_id if first else data["clinic_id"]
            new_clinic = data.get("clinic_id", old_clinic)
            clinic_rows = Clinic.objects.filter(pk__in={old_clinic, new_clinic}).order_by("pk").select_for_update()
            clinics = {row.pk: row for row in clinic_rows}
            if new_clinic not in clinics:
                raise ApiProblem(404, "NOT_FOUND", "找不到对应的门店。")
            if (first is None or new_clinic != old_clinic) and clinics[new_clinic].status != "ACTIVE":
                raise ApiProblem(409, "RESOURCE_CONFLICT", "停用门店不能新增牙椅。")
            if first is None:
                row = write_master_row(user, DentalChair, data)
                before = None
            else:
                row = DentalChair.objects.select_for_update().get(pk=pk)
                if row.clinic_id != old_clinic:
                    raise ApiProblem(409, "RESOURCE_CONFLICT", "牙椅归属已变更，请刷新。")
                before = chair_data(row)
                moved = new_clinic != old_clinic
                kind_changed = data.get("chair_kind", row.chair_kind) != row.chair_kind
                status_changed = data.get("status", row.status) != row.status
                usage = ChairUsage.objects.filter(chair_id=pk)
                if moved and (usage.exists() or DentalChairUnavailability.objects.filter(chair_id=pk).exists()):
                    raise ApiProblem(409, "RESOURCE_CONFLICT", "已有使用或停用记录的牙椅不能更换所属门店。")
                if (kind_changed or status_changed) and usage.filter(released_at__isnull=True).exists():
                    raise ApiProblem(409, "RESOURCE_CONFLICT", "正在使用的牙椅须先结束使用。")
                if row.status == "AVAILABLE" and (moved or kind_changed or status_changed):
                    now = timezone.now()
                    prior = load_capacity(old_clinic, now)
                    row.clinic_id = new_clinic
                    row.chair_kind = data.get("chair_kind", row.chair_kind)
                    row.status = data.get("status", row.status)
                    check_capacity_change(row, old_clinic, prior, now)
                row = write_master_row(user, DentalChair, data, pk=pk)
            after = chair_data(row)
            record_change(user, "DENTAL_CHAIR_SAVED", row, after, before)
            return after
    except IntegrityError as error:
        raise translate_integrity_error(error, {
            "dental_chair_clinic_id_chair_no_key": ("RESOURCE_CONFLICT", "本门店已有相同的牙椅编号。"),
        })


@api_view(["GET", "POST"])
def chairs(request):
    require_chain_master_access(request.user)
    if request.method == "POST":
        return success(save_chair(request.user, values(ChairRecord, request.data)), status_code=201)
    rows = DentalChair.objects.select_related("clinic").order_by("clinic__clinic_no", "chair_no")
    return success({
        "items": [chair_data(row) for row in rows],
        "clinics": [clinic_summary(clinic) for clinic in clinic_choices()],
    })


@api_view(["PATCH"])
def update_chair(request, pk):
    require_chain_master_access(request.user)
    return success(save_chair(request.user, update_fields(ChairRecord, request.data), pk))


def material_data(row, current_cost):
    return {
        "material_id": str(row.pk), "material_code": row.material_code, "material_name": row.material_name,
        "standard_unit": row.standard_unit, "status": row.status,
        "current_unit_cost": format(current_cost, ".2f") if current_cost is not None else None,
    }


def read_legacy_costs():
    try:
        return legacy_cost_versions()
    except ApiProblem:
        return {}


def save_material(user, data, pk=None):
    today = timezone.localdate(timezone=BUSINESS_ZONE)
    legacy = read_legacy_costs()

    def project(row):
        current = effective_material_costs(today).filter(material=row).first()
        return material_data(row, current.unit_cost if current else legacy_current_amount(legacy, row, today))

    return save_standard(
        user, Material, data, project, "MATERIAL_STANDARD_SAVED",
        {"material_material_code_key": ("RESOURCE_CONFLICT", "耗材编号已存在。")}, pk,
    )


@api_view(["GET", "POST"])
def materials(request):
    require_chain_master_access(request.user)
    if request.method == "POST":
        return success(save_material(request.user, values(MaterialStandard, request.data)), status_code=201)
    today = timezone.localdate(timezone=BUSINESS_ZONE)
    current = effective_material_costs(today).filter(material_id=OuterRef("pk")).values("unit_cost")[:1]
    rows = Material.objects.annotate(current_cost=Subquery(current)).order_by("material_code")
    legacy = read_legacy_costs()
    return success({"items": [
        material_data(row, row.current_cost if row.current_cost is not None else legacy_current_amount(legacy, row, today))
        for row in rows
    ]})


@api_view(["PATCH"])
def update_material(request, pk):
    require_chain_master_access(request.user)
    return success(save_material(request.user, update_fields(MaterialStandard, request.data), pk))


def cost_data(row):
    return {
        "cost_id": str(row.pk), "material_id": str(row.material_id), "unit_cost": format(row.unit_cost, ".2f"),
        "effective_from": row.effective_from.isoformat(),
        "effective_to": row.effective_to.isoformat() if row.effective_to else None,
    }


def add_cost(user, pk, data):
    replace_id = data.pop("replace_cost_id", None)
    replace_end = data.pop("replace_effective_to", None)
    try:
        with transaction.atomic():
            lock_master_rows(Material, [pk])
            material = get_object_or_404(Material, pk=pk)
            original = None
            if replace_id is not None:
                old = get_object_or_404(MaterialCost, pk=replace_id, material=material)
                if replace_end <= old.effective_from or (old.effective_to is not None and replace_end > old.effective_to):
                    raise ApiProblem(409, "RESOURCE_CONFLICT", "请选择原成本版本范围内的有效结束日期。")
                original = cost_data(old)
                write_master_row(user, MaterialCost, {"effective_to": replace_end}, pk=old.pk)
            row = write_master_row(user, MaterialCost, {"material_id": material.pk, **data})
            after = cost_data(row)
            record_change(user, "MATERIAL_COST_VERSION_CREATED", row, after, original)
            return after
    except IntegrityError as error:
        raise translate_integrity_error(error, {
            "material_cost_effective_excl": ("RESOURCE_CONFLICT", "同一耗材的成本生效区间不能重叠。"),
        })


@api_view(["GET", "POST"])
def material_costs(request, pk):
    require_chain_master_access(request.user)
    if request.method == "POST":
        return success(add_cost(request.user, pk, values(CostVersion, request.data)), status_code=201)
    material = get_object_or_404(Material, pk=pk)
    rows = MaterialCost.objects.filter(material=material).order_by("-effective_from", "pk")
    return success({"items": [cost_data(row) for row in rows]})


urlpatterns = [
    path("admin/qualifications", qualifications),
    path("admin/qualifications/<int:pk>", update_qualification),
    path("admin/dentist-qualifications", dentist_qualifications),
    path("admin/dentist-qualifications/<int:pk>", update_dentist_qualification),
    path("admin/chairs", chairs),
    path("admin/chairs/<int:pk>", update_chair),
    path("admin/materials", materials),
    path("admin/materials/<int:pk>", update_material),
    path("admin/materials/<int:pk>/costs", material_costs),
]
