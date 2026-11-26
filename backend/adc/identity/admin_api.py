from django.db import transaction
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.identity.audit import record_event
from adc.identity.models import AppRole, AuditLog, Clinic, Employee, EmployeeRole, UserAccount
from adc.identity.permissions import ACCESS_ADMIN_ROLE, HQ_ROLES, LOCAL_ROLES, current_principal


PRESET_ROLES = LOCAL_ROLES | {"HQ_SCHEDULER", "HQ_CATALOG", "HQ_OPERATIONS_QUERY"}
DEPLOYMENT_ROLES = (HQ_ROLES - PRESET_ROLES) | {ACCESS_ADMIN_ROLE}
ACCOUNT_STATUSES = ("ACTIVE", "INACTIVE")


class GrantChange(serializers.Serializer):
    role_code = serializers.CharField(max_length=50)
    clinic_id = serializers.IntegerField(min_value=1, max_value=2**63 - 1)
    expected_granted = serializers.BooleanField()
    granted = serializers.BooleanField()
    reason = serializers.CharField(max_length=500)


class AccountStatusChange(serializers.Serializer):
    expected_status = serializers.ChoiceField(choices=ACCOUNT_STATUSES)
    status = serializers.ChoiceField(choices=ACCOUNT_STATUSES)
    reason = serializers.CharField(max_length=500)


def deployment_managed(role_code, clinic_id):
    return role_code in DEPLOYMENT_ROLES or (role_code in HQ_ROLES and clinic_id is None)


def clinic_choices():
    return Clinic.objects.order_by("clinic_no").values(
        "clinic_id", "clinic_no", "clinic_name", "postal_address", "phone", "email", "status",
    )


def clinic_summary(clinic):
    return {
        "clinic_id": str(clinic["clinic_id"]),
        "clinic_no": clinic["clinic_no"],
        "name": clinic["clinic_name"],
        "status": clinic["status"],
    }


@api_view(["GET"])
def clinics(request):
    request.user.require(ACCESS_ADMIN_ROLE)
    return success({"items": [
        {
            **clinic_summary(clinic), "address": clinic["postal_address"],
            "phone": clinic["phone"], "email": clinic["email"],
        }
        for clinic in clinic_choices()
    ]})


@api_view(["GET"])
def access_directory(request):
    request.user.require(ACCESS_ADMIN_ROLE)
    role_rows = EmployeeRole.objects.order_by("role__role_code", "scope_clinic_id").values_list(
        "employee_id", "role__role_code", "scope_clinic_id",
    )
    protected = set()
    scoped_grants = {}
    for employee_id, role_code, clinic_id in role_rows:
        if deployment_managed(role_code, clinic_id):
            protected.add(employee_id)
        if role_code in PRESET_ROLES and clinic_id is not None:
            scoped_grants.setdefault(employee_id, []).append({"role_code": role_code, "clinic_id": str(clinic_id)})

    employees = []
    for employee_id, number, name, employee_status, account_status in Employee.objects.order_by(
        "employee_no",
    ).values_list("pk", "employee_no", "full_name", "status", "useraccount__status"):
        other_employee = employee_id != request.user.employee_id
        employees.append({
            "employee_id": str(employee_id), "employee_no": number, "full_name": name,
            "employee_status": employee_status, "account_status": account_status,
            "can_manage_account": other_employee and employee_id not in protected and account_status in ACCOUNT_STATUSES,
            "can_manage_grants": other_employee, "grants": scoped_grants.get(employee_id, []),
        })
    return success({
        "clinics": [clinic_summary(clinic) for clinic in clinic_choices()],
        "employees": employees,
        "roles": list(AppRole.objects.filter(role_code__in=PRESET_ROLES).order_by("role_code").values(
            "role_code", "role_name",
        )),
    })


def lock_access_target(request, employee_id):
    actor = request.user
    if employee_id == actor.employee_id:
        raise ApiProblem(403, "PERMISSION_DENIED", "不能修改自己的门店授权或账号状态。")

    affected = (actor.employee_id, employee_id)
    # Deployment scope changes take the employee lock as well. Lock both employees
    # in the same order for grants, revocations and account status changes.
    employees = list(Employee.objects.select_for_update(no_key=True).filter(pk__in=affected).order_by(
        "pk",
    ).values_list("pk", flat=True))
    accounts = {
        account.employee_id: account
        for account in UserAccount.objects.select_for_update(no_key=True).filter(employee_id__in=affected).order_by("pk")
    }
    principal = current_principal(actor.account_id, "staff")
    if principal is None:
        raise ApiProblem(401, "AUTHENTICATION_REQUIRED", "请登录后继续。")
    principal.require(ACCESS_ADMIN_ROLE)
    if employee_id not in employees:
        raise ApiProblem(404, "NOT_FOUND", "找不到该员工。")
    return accounts.get(employee_id)


def require_expected_state(current, expected, desired):
    if current != expected:
        raise ApiProblem(409, "STALE_ACCESS_STATE", "资料已更新，请重新查询后再提交。")
    if current == desired:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择需要变更的状态。")


def change_result(event):
    values = {key: value for key, value in event.after_value.items() if key not in {"version", "reason"}}
    return success({"employee_id": str(event.target_id), **values})


@api_view(["POST"])
def employee_grants(request, employee_id):
    request.user.require(ACCESS_ADMIN_ROLE)
    payload = GrantChange(data=request.data)
    payload.is_valid(raise_exception=True)
    data = dict(payload.validated_data)
    role_code, clinic_id = data["role_code"], data["clinic_id"]
    if role_code not in PRESET_ROLES:
        raise ApiProblem(403, "PERMISSION_DENIED", "该角色由部署配置维护。")
    operation = OperationKey.from_request(request, command="EMPLOYEE_SCOPE_CHANGED", target={"employee_id": employee_id})

    with transaction.atomic():
        lock_access_target(request, employee_id)
        prior_id = operation.result_id(data)
        if prior_id is not None:
            return change_result(AuditLog.objects.get(pk=prior_id))
        role = get_object_or_404(AppRole, role_code=role_code)
        clinic = get_object_or_404(Clinic, pk=clinic_id)
        grants = EmployeeRole.objects.filter(employee_id=employee_id, role=role, scope_clinic=clinic)
        existed = grants.exists()
        require_expected_state(existed, data["expected_granted"], data["granted"])
        if data["granted"]:
            grants.create(employee_id=employee_id, role=role, scope_clinic=clinic)
        else:
            grants.delete()

        scope = {"role_code": role_code, "clinic_id": str(clinic.pk)}
        event = record_event(
            account_id=request.user.account_id, action="EMPLOYEE_SCOPE_CHANGED", target_type="employee",
            target_id=employee_id, visible_fields=("role_code", "clinic_id", "granted", "reason"),
            before={**scope, "granted": existed}, after={**scope, "granted": data["granted"], "reason": data["reason"]},
        )
        operation.record_result(event.pk, data)
        return change_result(event)


@api_view(["POST"])
def employee_account_status(request, employee_id):
    request.user.require(ACCESS_ADMIN_ROLE)
    payload = AccountStatusChange(data=request.data)
    payload.is_valid(raise_exception=True)
    data = dict(payload.validated_data)
    operation = OperationKey.from_request(
        request, command="EMPLOYEE_ACCOUNT_STATUS_CHANGED", target={"employee_id": employee_id},
    )

    with transaction.atomic():
        account = lock_access_target(request, employee_id)
        if account is None:
            raise ApiProblem(404, "NOT_FOUND", "该员工尚未配置登录账号。")
        if any(deployment_managed(role, clinic) for role, clinic in EmployeeRole.objects.filter(
            employee_id=employee_id,
        ).values_list("role__role_code", "scope_clinic_id")):
            raise ApiProblem(403, "PERMISSION_DENIED", "该员工的账号状态由部署配置维护。")
        prior_id = operation.result_id(data)
        if prior_id is not None:
            return change_result(AuditLog.objects.get(pk=prior_id))
        require_expected_state(account.status, data["expected_status"], data["status"])

        before = {"status": account.status}
        account.status = data["status"]
        account.save(update_fields=["status"])
        event = record_event(
            account_id=request.user.account_id, action="EMPLOYEE_ACCOUNT_STATUS_CHANGED", target_type="employee",
            target_id=employee_id, visible_fields=("status", "reason"),
            before=before, after={"status": account.status, "reason": data["reason"]},
        )
        operation.record_result(event.pk, data)
        return change_result(event)


urlpatterns = [
    path("admin/clinics", clinics),
    path("admin/access", access_directory),
    path("admin/access/employees/<int:employee_id>/grants", employee_grants),
    path("admin/access/employees/<int:employee_id>/account-status", employee_account_status),
]
