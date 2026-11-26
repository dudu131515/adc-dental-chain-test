from dataclasses import dataclass

from adc.common.http import ApiProblem
from adc.identity.models import EmployeeRole, UserAccount


ACCESS_ADMIN_ROLE = "HQ_ACCESS_ADMIN"
LOCAL_ROLES = frozenset({"FRONT_DESK", "DENTIST", "CLINIC_MANAGER"})
HQ_ROLES = frozenset({
    "HQ_SCHEDULER", "HQ_CATALOG", "HQ_OPERATIONS_QUERY",
    "HQ_PERFORMANCE_CALCULATE", "HQ_PERFORMANCE_REVIEW", "HQ_PERFORMANCE_CONFIRM",
})


@dataclass(frozen=True)
class Principal:
    account_id: int
    channel: str
    employee_id: int | None
    patient_id: int | None
    grants: frozenset[tuple[str, int | None]]

    @property
    def is_authenticated(self):
        return True

    @property
    def capabilities(self):
        return sorted({
            role for role, clinic in self.grants
            if role in HQ_ROLES or (role in LOCAL_ROLES and clinic is not None)
            or (role == ACCESS_ADMIN_ROLE and clinic is None)
        })

    def clinic_scope(self, *roles):
        allowed_roles = set(roles)
        if ACCESS_ADMIN_ROLE in allowed_roles and (ACCESS_ADMIN_ROLE, None) in self.grants:
            return None
        if any(role in HQ_ROLES & allowed_roles and clinic is None for role, clinic in self.grants):
            return None
        return {
            clinic for role, clinic in self.grants
            if role in (LOCAL_ROLES | HQ_ROLES) & allowed_roles and clinic is not None
        }

    def allows(self, role, clinic_id=None):
        if self.channel != "staff" or role not in self.capabilities:
            return False
        if clinic_id is None:
            return True
        scope = self.clinic_scope(role)
        return scope is None or clinic_id in scope

    def require(self, role, clinic_id=None):
        if not self.allows(role, clinic_id):
            raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能办理此操作。")


def current_principal(account_id, channel):
    account = UserAccount.objects.select_related("employee").filter(pk=account_id, status="ACTIVE").first()
    if not account:
        return None
    if channel == "staff" and account.employee_id and account.employee.status != "INACTIVE":
        grants = EmployeeRole.objects.filter(employee_id=account.employee_id).values_list(
            "role__role_code", "scope_clinic_id",
        )
        return Principal(account.pk, "staff", account.employee_id, None, frozenset(grants))
    if channel == "patient" and account.patient_id:
        return Principal(account.pk, "patient", None, account.patient_id, frozenset())
    return None
