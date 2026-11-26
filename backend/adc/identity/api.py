from hashlib import sha256
import json
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen
from uuid import uuid4

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.db import connection, transaction
from django.middleware.csrf import get_token, rotate_token
from django.urls import path
from rest_framework import serializers
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny

from adc.common.http import ApiProblem, success, unavailable
from adc.identity.admin_api import employee_profile, urlpatterns as admin_patterns
from adc.identity.audit import record_event
from adc.identity.authentication import create_token, load_token
from adc.identity.models import Clinic, Employee, Patient, UserAccount
from adc.identity.permissions import HQ_ROLES, LOCAL_ROLES, current_principal


class StaffLogin(serializers.Serializer):
    login_identity = serializers.CharField(max_length=180)
    password = serializers.CharField(max_length=512, trim_whitespace=False)


class WechatLogin(serializers.Serializer):
    code = serializers.CharField(max_length=256)


class PatientProfile(serializers.Serializer):
    full_name = serializers.CharField(max_length=100)
    birth_date = serializers.DateField()
    billing_address = serializers.CharField()
    phone = serializers.CharField(max_length=40)
    email = serializers.EmailField(max_length=120, required=False, allow_null=True)
    emergency_name = serializers.CharField(max_length=100)
    emergency_phone = serializers.CharField(max_length=40)


class BindProfile(PatientProfile):
    profile_token = serializers.CharField(max_length=100)


def principal_data(principal):
    data = {"account_id": str(principal.account_id), "category": principal.channel}
    if principal.channel == "patient":
        return {**data, "patient_id": str(principal.patient_id), "capabilities": ["PATIENT"], "clinics": []}
    scope = principal.clinic_scope(*(LOCAL_ROLES | HQ_ROLES))
    clinics = Clinic.objects.all()
    if scope is not None:
        clinics = clinics.filter(pk__in=scope)
    return {
        **data,
        **employee_profile(Employee.objects.select_related("home_clinic").get(pk=principal.employee_id)),
        "account_status": "ACTIVE",
        "employee_id": str(principal.employee_id),
        "capabilities": principal.capabilities,
        "role_clinic_ids": {
            role: None if principal.clinic_scope(role) is None else sorted(map(str, principal.clinic_scope(role)))
            for role in principal.capabilities
        },
        "clinics": [
            {"clinic_id": str(c.pk), "name": c.clinic_name}
            for c in clinics.order_by("clinic_no")
        ],
    }


def wechat_identity(code):
    openid = settings.ADC_MINI_SYNTHETIC_CODES.get(code) if settings.ADC_ENV in {"local", "test"} else None
    if openid is None:
        if not settings.ADC_WECHAT_APP_ID or not settings.ADC_WECHAT_SECRET:
            raise unavailable("小程序身份校验尚未配置。")
        query = urlencode({
            "appid": settings.ADC_WECHAT_APP_ID, "secret": settings.ADC_WECHAT_SECRET,
            "js_code": code, "grant_type": "authorization_code",
        })
        try:
            with urlopen(f"https://api.weixin.qq.com/sns/jscode2session?{query}", timeout=8) as reply:
                body = json.load(reply)
        except (URLError, TimeoutError, ValueError):
            raise unavailable("暂时无法核验微信身份。") from None
        openid = body.get("openid") if isinstance(body, dict) else None
        if not isinstance(openid, str) or not openid:
            raise ApiProblem(401, "AUTHENTICATION_REQUIRED", "微信身份校验失败。")
    return "wx:" + sha256(openid.encode("utf-8")).hexdigest()


def patient_session(account):
    principal = current_principal(account.pk, "patient")
    if principal is None:
        raise ApiProblem(403, "PERMISSION_DENIED", "当前患者账号不可用。")
    token = create_token("patient", {"account_id": account.pk}, maximum_age=8 * 60 * 60)
    return {**principal_data(principal), "token": token, "profile_required": False}


@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
def web_csrf(request):
    return success({"csrf_token": get_token(request)})


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def web_login(request):
    SessionAuthentication().enforce_csrf(request)
    payload = StaffLogin(data=request.data)
    payload.is_valid(raise_exception=True)
    identity = payload.validated_data["login_identity"]
    password = payload.validated_data["password"]
    password_hash = settings.ADC_STAFF_PASSWORD_HASHES.get(identity)
    if not password_hash:
        make_password(password)
    account = UserAccount.objects.filter(login_identity=identity, employee__isnull=False).first()
    principal = current_principal(account.pk, "staff") if account else None
    if not password_hash or not check_password(password, password_hash) or principal is None:
        raise ApiProblem(401, "AUTHENTICATION_REQUIRED", "登录信息无效。")
    request.session.cycle_key()
    request.session["adc_channel"] = "staff"
    request.session["account_id"] = account.pk
    rotate_token(request)
    return success(principal_data(principal))


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def mini_login(request):
    payload = WechatLogin(data=request.data)
    payload.is_valid(raise_exception=True)
    identity = wechat_identity(payload.validated_data["code"])
    account = UserAccount.objects.filter(login_identity=identity, patient__isnull=False).first()
    if account is not None:
        return success(patient_session(account))
    token = create_token("profile", {"identity": identity}, maximum_age=600)
    return success({"profile_required": True, "profile_token": token})


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def bind_profile(request):
    payload = BindProfile(data=request.data)
    payload.is_valid(raise_exception=True)
    profile = dict(payload.validated_data)
    session = load_token(profile.pop("profile_token"), "profile")
    if session is None:
        raise ApiProblem(401, "AUTHENTICATION_REQUIRED", "请重新核验微信身份。")
    identity = session["identity"]
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [identity])
        account = UserAccount.objects.filter(login_identity=identity).first()
        created = account is None
        if created:
            patient = Patient.objects.create(patient_no=f"P-{uuid4().hex.upper()}", **profile)
            account = UserAccount.objects.create(patient=patient, login_identity=identity)
            record_event(
                account_id=account.pk, action="PATIENT_BOUND", target_type="patient", target_id=patient.pk,
                visible_fields=("patient_id",), after={"patient_id": str(patient.pk)},
            )
    return success(patient_session(account), status_code=201 if created else 200)


@api_view(["GET"])
def me(request):
    return success(principal_data(request.user))


@api_view(["POST"])
def logout(request):
    request.auth.flush()
    return success(status_code=204)


urlpatterns = [
    path("auth/web/csrf", web_csrf),
    path("auth/web/login", web_login),
    path("auth/mini/login", mini_login),
    path("auth/mini/bind-profile", bind_profile),
    path("auth/me", me),
    path("auth/logout", logout),
] + admin_patterns
