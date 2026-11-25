from adc.common.http import ApiProblem
from adc.identity.models import Clinic


QUERY = "HQ_OPERATIONS_QUERY"
CALCULATE = "HQ_PERFORMANCE_CALCULATE"
REVIEW = "HQ_PERFORMANCE_REVIEW"
CONFIRM = "HQ_PERFORMANCE_CONFIRM"
WORK_ROLES = (CALCULATE, REVIEW, CONFIRM)
PERFORMANCE_ROLES = (QUERY, *WORK_ROLES)


def includes_company(scope):
    if scope is None:
        return True
    return bool(scope) and not Clinic.objects.exclude(pk__in=scope).exists()


def require_company(principal, role):
    principal.require(role)
    if not includes_company(principal.clinic_scope(role)):
        raise ApiProblem(403, "PERMISSION_DENIED", "该操作需要完整公司核算范围。")


def visible_scope(principal, *roles):
    scope = principal.clinic_scope(*roles)
    if scope == set():
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号没有可访问的门店范围。")
    return scope


def filter_clinics(query, scope, field="clinic_id"):
    return query if scope is None else query.filter(**{field + "__in": scope})
