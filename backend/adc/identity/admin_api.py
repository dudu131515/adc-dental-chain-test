from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.contrib.auth.password_validation import CommonPasswordValidator, NumericPasswordValidator, validate_password
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils.crypto import salted_hmac
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.models import SlotClaim
from adc.common.http import ApiProblem, success, translate_integrity_error
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values
from adc.identity.audit import record_event
from adc.identity.master_data_write import write_master_row
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


class EmployeePlacement(serializers.Serializer):
    job_code = serializers.ChoiceField(choices=Employee.Job.values)
    home_clinic_id = ID(allow_null=True)

    def validate(self, fields):
        headquarters = fields["job_code"] == Employee.Job.HEADQUARTERS
        if headquarters != (fields["home_clinic_id"] is None):
            raise serializers.ValidationError({"home_clinic_id": "总部岗位归属总部，门店岗位请选择所属门店。"})
        return fields


class EmployeeProfileChange(EmployeePlacement):
    expected_job_code = serializers.ChoiceField(choices=Employee.Job.values, allow_null=True)
    expected_home_clinic_id = ID(allow_null=True)
    reason = serializers.CharField(max_length=500)


class NewAccount(serializers.Serializer):
    login_identity = serializers.CharField(max_length=180)
    password = serializers.CharField(min_length=12, max_length=512, trim_whitespace=False, write_only=True)

    def validate_login_identity(self, identity):
        if identity.lower().startswith("wx:") or identity in settings.ADC_STAFF_PASSWORD_HASHES:
            raise serializers.ValidationError("此登录名已保留，请使用其他登录名。")
        return identity

    def validate_password(self, password):
        if not password.strip():
            raise serializers.ValidationError("请使用至少 12 位且不常见的非纯数字密码。")
        try:
            validate_password(password, password_validators=[CommonPasswordValidator(), NumericPasswordValidator()])
        except ValidationError:
            raise serializers.ValidationError("请使用至少 12 位且不常见的非纯数字密码。") from None
        return password


class NewEmployee(EmployeePlacement):
    employee_no = serializers.CharField(max_length=40)
    full_name = serializers.CharField(max_length=100)
    account = NewAccount(required=False, allow_null=True)


class ClinicRecord(serializers.Serializer):
    clinic_no = serializers.CharField(max_length=40)
    name = serializers.CharField(source="clinic_name", max_length=150)
    address = serializers.CharField(source="postal_address")
    phone = serializers.CharField(max_length=40, required=False, allow_null=True, allow_blank=True)
    email = serializers.EmailField(max_length=120, required=False, allow_null=True, allow_blank=True)
    status = serializers.ChoiceField(choices=ACCOUNT_STATUSES, required=False)


def employee_profile(employee):
    clinic = employee.home_clinic
    return {
        "employee_no": employee.employee_no, "full_name": employee.full_name,
        "employee_status": employee.status, "job_code": employee.job_code,
        "home_clinic": {"clinic_id": str(clinic.pk), "name": clinic.clinic_name} if clinic else None,
    }


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


def clinic_data(clinic):
    return {
        **clinic_summary(clinic), "address": clinic["postal_address"],
        "phone": clinic["phone"], "email": clinic["email"],
    }


def save_clinic(request, data, clinic_id=None):
    try:
        with transaction.atomic():
            if clinic_id is None:
                clinic = write_master_row(request.user, Clinic, data)
                before = None
            else:
                clinic = get_object_or_404(Clinic.objects.select_for_update(), pk=clinic_id)
                before = clinic_data(clinic_choices().get(pk=clinic_id))
                clinic = write_master_row(request.user, Clinic, data, pk=clinic.pk)
                if before["status"] == "ACTIVE" and clinic.status == "INACTIVE":
                    SlotClaim.objects.filter(clinic_id=clinic.pk, status="HOLD").update(status="RELEASED")
            after = clinic_data(clinic_choices().get(pk=clinic.pk))
            record_event(
                account_id=request.user.account_id, action="CLINIC_SAVED", target_type="clinic",
                target_id=clinic.pk, visible_fields=after.keys(), before=before, after=after,
            )
            return after
    except IntegrityError as error:
        raise translate_integrity_error(error, {"clinic_clinic_no_key": ("RESOURCE_CONFLICT", "门店编号已存在。")})


@api_view(["GET", "POST"])
def clinics(request):
    request.user.require(ACCESS_ADMIN_ROLE)
    if request.method == "POST":
        return success(save_clinic(request, values(ClinicRecord, request.data)), status_code=201)
    return success({"items": [clinic_data(clinic) for clinic in clinic_choices()]})


@api_view(["PATCH"])
def update_clinic(request, clinic_id):
    request.user.require(ACCESS_ADMIN_ROLE)
    data = values(ClinicRecord, request.data, partial=True)
    if not data:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择需要修改的门店字段。")
    return success(save_clinic(request, data, clinic_id))


@api_view(["GET"])
def access_directory(request):
    request.user.require(ACCESS_ADMIN_ROLE)
    role_rows = EmployeeRole.objects.order_by("role__role_code", "scope_clinic_id").values_list(
        "employee_id", "role__role_code", "scope_clinic_id",
    )
    protected = set()
    scoped_grants, permissions = {}, {}
    for employee_id, role_code, clinic_id in role_rows:
        managed = deployment_managed(role_code, clinic_id)
        if managed:
            protected.add(employee_id)
        grant = {"role_code": role_code, "clinic_id": str(clinic_id) if clinic_id is not None else None}
        if (role_code in LOCAL_ROLES and clinic_id is not None) or role_code in HQ_ROLES or (
            role_code == ACCESS_ADMIN_ROLE and clinic_id is None
        ):
            permissions.setdefault(employee_id, []).append({**grant, "managed_by_deployment": managed})
        if role_code in PRESET_ROLES and clinic_id is not None:
            scoped_grants.setdefault(employee_id, []).append(grant)

    employees = []
    for employee in Employee.objects.select_related("home_clinic", "useraccount").order_by("employee_no"):
        account = getattr(employee, "useraccount", None)
        account_status = account.status if account else None
        other_employee = employee.pk != request.user.employee_id
        employees.append({
            **employee_profile(employee), "employee_id": str(employee.pk), "account_status": account_status,
            "can_manage_account": other_employee and employee.pk not in protected and account_status in ACCOUNT_STATUSES,
            "can_manage_grants": other_employee, "can_manage_profile": other_employee,
            "grants": scoped_grants.get(employee.pk, []), "permissions": permissions.get(employee.pk, []),
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


def require_account_manageable(employee_id):
    if any(deployment_managed(role, clinic) for role, clinic in EmployeeRole.objects.filter(
        employee_id=employee_id,
    ).values_list("role__role_code", "scope_clinic_id")):
        raise ApiProblem(403, "PERMISSION_DENIED", "该员工的账号由部署配置维护。")


def account_operation_data(account):
    return {
        "login_identity": account["login_identity"],
        "password_digest": salted_hmac("adc.employee-provisioning", account["password"], algorithm="sha256").hexdigest(),
    }


def create_staff_account(user, employee_id, data):
    return write_master_row(user, UserAccount, {
        "employee_id": employee_id,
        "login_identity": data["login_identity"],
        "staff_password_hash": make_password(data["password"], hasher="pbkdf2_sha256"),
    })


CREATE_EMPLOYEE_CONSTRAINTS = {
    "employee_employee_no_key": ("RESOURCE_CONFLICT", "员工编号已存在。"),
    "user_account_login_identity_key": ("RESOURCE_CONFLICT", "登录名已存在。"),
    "user_account_employee_id_key": ("RESOURCE_CONFLICT", "该员工已有登录账号。"),
}


@api_view(["POST"])
def create_employee(request):
    request.user.require(ACCESS_ADMIN_ROLE)
    data = values(NewEmployee, request.data)
    account_data = data.pop("account", None)
    operation = OperationKey.from_request(request, command="EMPLOYEE_CREATED", target={})
    normalized = {**data, "account": account_operation_data(account_data) if account_data else None}
    try:
        with transaction.atomic():
            actor = request.user
            Employee.objects.select_for_update(no_key=True).get(pk=actor.employee_id)
            UserAccount.objects.select_for_update(no_key=True).get(pk=actor.account_id)
            principal = current_principal(actor.account_id, "staff")
            if principal is None:
                raise ApiProblem(401, "AUTHENTICATION_REQUIRED", "请登录后继续。")
            principal.require(ACCESS_ADMIN_ROLE)
            prior_id = operation.result_id(normalized)
            if prior_id is not None:
                return change_result(AuditLog.objects.get(pk=prior_id))
            clinic_id = data["home_clinic_id"]
            if clinic_id is not None:
                get_object_or_404(Clinic.objects.select_for_update(), pk=clinic_id, status="ACTIVE")
            employee = write_master_row(actor, Employee, data)
            account = create_staff_account(actor, employee.pk, account_data) if account_data else None
            after = {
                "employee_no": employee.employee_no, "job_code": employee.job_code,
                "home_clinic_id": str(clinic_id) if clinic_id is not None else None,
                "account_status": account.status if account else None,
            }
            event = record_event(
                account_id=actor.account_id, action="EMPLOYEE_CREATED", target_type="employee",
                target_id=employee.pk, visible_fields=after.keys(), after=after,
            )
            operation.record_result(event.pk, normalized)
            return change_result(event, status_code=201)
    except IntegrityError as error:
        raise translate_integrity_error(error, CREATE_EMPLOYEE_CONSTRAINTS)


@api_view(["POST"])
def create_employee_account(request, employee_id):
    request.user.require(ACCESS_ADMIN_ROLE)
    data = values(NewAccount, request.data)
    operation = OperationKey.from_request(request, command="EMPLOYEE_ACCOUNT_CREATED", target={"employee_id": employee_id})
    normalized = account_operation_data(data)
    try:
        with transaction.atomic():
            previous = lock_access_target(request, employee_id)
            require_account_manageable(employee_id)
            prior_id = operation.result_id(normalized)
            if prior_id is not None:
                return change_result(AuditLog.objects.get(pk=prior_id))
            if previous is not None:
                raise ApiProblem(409, "RESOURCE_CONFLICT", "该员工已有登录账号。")
            if not Employee.objects.filter(pk=employee_id, status="ACTIVE").exists():
                raise ApiProblem(409, "RESOURCE_CONFLICT", "只能为在职员工开通登录账号。")
            account = create_staff_account(request.user, employee_id, data)
            event = record_event(
                account_id=request.user.account_id, action="EMPLOYEE_ACCOUNT_CREATED", target_type="employee",
                target_id=employee_id, visible_fields=("account_status",), after={"account_status": account.status},
            )
            operation.record_result(event.pk, normalized)
            return change_result(event, status_code=201)
    except IntegrityError as error:
        raise translate_integrity_error(error, CREATE_EMPLOYEE_CONSTRAINTS)


def require_expected_state(current, expected, desired):
    if current != expected:
        raise ApiProblem(409, "STALE_ACCESS_STATE", "资料已更新，请重新查询后再提交。")
    if current == desired:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择需要变更的状态。")


def change_result(event, *, status_code=200):
    values = {key: value for key, value in event.after_value.items() if key not in {"version", "reason"}}
    return success({"employee_id": str(event.target_id), **values}, status_code=status_code)


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
        clinic = get_object_or_404(Clinic.objects.select_for_update(no_key=True), pk=clinic_id)
        if data["granted"] and clinic.status != "ACTIVE":
            raise ApiProblem(409, "RESOURCE_CONFLICT", "停用门店不能新增授权。")
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
        require_account_manageable(employee_id)
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


@api_view(["POST"])
def change_employee_profile(request, employee_id):
    request.user.require(ACCESS_ADMIN_ROLE)
    payload = EmployeeProfileChange(data=request.data)
    payload.is_valid(raise_exception=True)
    data = dict(payload.validated_data)
    operation = OperationKey.from_request(
        request, command="EMPLOYEE_PROFILE_CHANGED", target={"employee_id": employee_id},
    )
    with transaction.atomic():
        lock_access_target(request, employee_id)
        prior_id = operation.result_id(data)
        if prior_id is not None:
            return change_result(AuditLog.objects.get(pk=prior_id))
        employee = Employee.objects.get(pk=employee_id)
        current = (employee.job_code, employee.home_clinic_id)
        expected = (data["expected_job_code"], data["expected_home_clinic_id"])
        desired = (data["job_code"], data["home_clinic_id"])
        require_expected_state(current, expected, desired)
        if desired[1] is not None and current[1] != desired[1]:
            get_object_or_404(Clinic.objects.select_for_update(), pk=desired[1], status="ACTIVE")
        employee.job_code, employee.home_clinic_id = desired
        employee.save(update_fields=["job_code", "home_clinic"])
        before = {"job_code": current[0], "home_clinic_id": str(current[1]) if current[1] is not None else None}
        after = {"job_code": desired[0], "home_clinic_id": str(desired[1]) if desired[1] is not None else None,
                 "reason": data["reason"]}
        event = record_event(
            account_id=request.user.account_id, action="EMPLOYEE_PROFILE_CHANGED", target_type="employee",
            target_id=employee_id, visible_fields=("job_code", "home_clinic_id", "reason"), before=before, after=after,
        )
        operation.record_result(event.pk, data)
        return change_result(event)


@api_view(["GET"])
def employee_history(request, employee_id):
    request.user.require(ACCESS_ADMIN_ROLE)
    get_object_or_404(Employee, pk=employee_id)
    fields = {
        "EMPLOYEE_CREATED": ("employee_no", "job_code", "home_clinic_id", "account_status"),
        "EMPLOYEE_ACCOUNT_CREATED": ("account_status",),
        "EMPLOYEE_SCOPE_CHANGED": ("clinic_id", "role_code", "granted"),
        "EMPLOYEE_ACCOUNT_STATUS_CHANGED": ("status",),
        "EMPLOYEE_PROFILE_CHANGED": ("job_code", "home_clinic_id"),
    }
    events = AuditLog.objects.filter(
        action__in=fields, target_type="employee", target_id=employee_id,
    ).order_by("-occurred_at", "-pk")[:50]
    return success({"items": [
        {
            "audit_id": str(event.pk), "action": event.action,
            "occurred_at": event.occurred_at.isoformat(),
            "actor_account_id": str(event.account_id) if event.account_id is not None else None,
            "before": {key: event.before_value[key] for key in fields[event.action] if key in (event.before_value or {})},
            "after": {key: event.after_value[key] for key in (*fields[event.action], "reason") if key in (event.after_value or {})},
        }
        for event in events
    ]})


urlpatterns = [
    path("admin/clinics", clinics),
    path("admin/clinics/<int:clinic_id>", update_clinic),
    path("admin/access", access_directory),
    path("admin/access/employees", create_employee),
    path("admin/access/employees/<int:employee_id>/account", create_employee_account),
    path("admin/access/employees/<int:employee_id>/grants", employee_grants),
    path("admin/access/employees/<int:employee_id>/history", employee_history),
    path("admin/access/employees/<int:employee_id>/profile", change_employee_profile),
    path("admin/access/employees/<int:employee_id>/account-status", employee_account_status),
]
