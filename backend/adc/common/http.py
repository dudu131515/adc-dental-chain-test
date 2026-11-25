import logging
from uuid import uuid4

from django.core import signing
from django.db import IntegrityError
from django.http import JsonResponse
from rest_framework import exceptions, status
from rest_framework.response import Response


logger = logging.getLogger(__name__)
CURSOR_SALT = "adc.cursor.v1"


class ApiProblem(exceptions.APIException):
    def __init__(self, status_code, code, message, *, field_errors=None, details=None):
        self.status_code = status_code
        self.code = code
        self.field_errors = field_errors or {}
        self.details = details or {}
        super().__init__(message, code=code)


def success(data=None, *, status_code=status.HTTP_200_OK):
    if status_code == status.HTTP_204_NO_CONTENT:
        return Response(status=status_code, headers={"Cache-Control": "no-store"})
    return Response({"data": data}, status=status_code, headers={"Cache-Control": "no-store"})


def error_response(request, problem):
    request_id = getattr(request, "adc_request_id", None) or uuid4().hex
    request.adc_request_id = request_id
    return JsonResponse(
        {
            "error": {
                "code": problem.code,
                "message": str(problem.detail),
                "field_errors": problem.field_errors,
                "request_id": request_id,
                "details": problem.details,
            },
        },
        status=problem.status_code,
        headers={"X-Request-ID": request_id, "Cache-Control": "no-store"},
    )


def exception_handler(exc, context):
    request = context["request"]
    if isinstance(exc, ApiProblem):
        problem = exc
    elif isinstance(exc, exceptions.ValidationError):
        fields = exc.detail if isinstance(exc.detail, dict) else {"non_field_errors": exc.detail}
        problem = ApiProblem(400, "VALIDATION_ERROR", "请检查输入内容。", field_errors=fields)
    elif isinstance(exc, exceptions.ParseError):
        problem = ApiProblem(400, "VALIDATION_ERROR", "请求内容格式无效。")
    else:
        from rest_framework.views import exception_handler as framework_exception_handler

        fallback = framework_exception_handler(exc, context)
        problems = {
            400: ("VALIDATION_ERROR", "请检查输入内容。"),
            401: ("AUTHENTICATION_REQUIRED", "请登录后继续。"),
            403: ("PERMISSION_DENIED", "当前账号不能办理此操作。"),
            404: ("NOT_FOUND", "找不到可访问的记录。"),
            405: ("METHOD_NOT_ALLOWED", "此请求方式不可用。"),
            415: ("VALIDATION_ERROR", "此请求格式不可用。"),
            429: ("TOO_MANY_REQUESTS", "请求过于频繁，请稍后重试。"),
        }
        if fallback and fallback.status_code in problems:
            problem = ApiProblem(fallback.status_code, *problems[fallback.status_code])
        else:
            request.adc_request_id = uuid4().hex
            logger.error("ADC request %s failed with %s", request.adc_request_id, type(exc).__name__)
            problem = ApiProblem(500, "SERVER_ERROR", "暂时无法完成请求，请保留关联号。")
    response = error_response(request, problem)
    if problem.status_code == 401:
        response["WWW-Authenticate"] = "Bearer"
    return response


def not_found(request, *args, **kwargs):
    return error_response(request, ApiProblem(404, "NOT_FOUND", "找不到可访问的记录。"))


def unavailable(message="服务暂不可用，请稍后核对办理结果。"):
    return ApiProblem(503, "SERVICE_UNAVAILABLE", message)


def scoped_cursor(binding, position):
    return signing.dumps({"scope": binding, "position": position}, salt=CURSOR_SALT)


def cursor_position(encoded, binding):
    try:
        cursor = signing.loads(encoded, salt=CURSOR_SALT)
    except signing.BadSignature:
        cursor = {}
    if cursor.get("scope") != binding or "position" not in cursor:
        raise ApiProblem(400, "VALIDATION_ERROR", "列表范围已改变，请重新查询。")
    return cursor["position"]


def translate_integrity_error(error: IntegrityError, known_constraints):
    """Map expected PostgreSQL constraints after the write transaction was rolled back."""
    cause = error.__cause__
    constraint_name = getattr(getattr(cause, "diag", None), "constraint_name", None)
    if constraint_name in known_constraints:
        code, message = known_constraints[constraint_name]
        return ApiProblem(409, code, message)
    return error
