from datetime import timedelta
from hashlib import sha256
import re
from secrets import token_urlsafe

from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.utils import timezone
from rest_framework.authentication import BaseAuthentication, SessionAuthentication
from rest_framework.permissions import SAFE_METHODS

from adc.common.http import ApiProblem
from adc.identity.permissions import current_principal


TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}\Z")


def create_token(channel, data, *, maximum_age):
    token = token_urlsafe(32)
    Session.objects.create(
        session_key=token_key(token),
        session_data=SessionStore().encode({"adc_channel": channel, **data}),
        expire_date=timezone.now() + timedelta(seconds=maximum_age),
    )
    return token


def token_key(token):
    return sha256(token.encode("ascii")).hexdigest()[:40]


def load_token(token, channel):
    if not TOKEN_PATTERN.fullmatch(token):
        return None
    session = SessionStore(session_key=token_key(token))
    if session.get("adc_channel") != channel:
        return None
    return session


def authentication_required():
    return ApiProblem(401, "AUTHENTICATION_REQUIRED", "请登录后继续。")


class ADCAuthentication(BaseAuthentication):
    def authenticate_header(self, request):
        return "Bearer"

    def authenticate(self, request):
        bearer = request.headers.get("Authorization")
        if bearer:
            prefix, _, token = bearer.partition(" ")
            session = load_token(token, "patient") if prefix.lower() == "bearer" else None
            if session is None:
                raise authentication_required()
            principal = current_principal(session.get("account_id"), "patient")
            if principal is None:
                raise authentication_required()
            return principal, session
        if request.session.get("adc_channel") != "staff":
            return None
        principal = current_principal(request.session.get("account_id"), "staff")
        if principal is None:
            raise authentication_required()
        if request.method not in SAFE_METHODS:
            SessionAuthentication().enforce_csrf(request)
        return principal, request.session
