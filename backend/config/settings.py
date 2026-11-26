import json
import os
from urllib.parse import parse_qs, unquote, urlsplit

from django.core.exceptions import ImproperlyConfigured


def require(name):
    value = os.environ.get(name)
    if not value:
        raise ImproperlyConfigured(f"Set {name} in the application environment.")
    return value


def csv_environment(name, default=""):
    return [value.strip() for value in os.environ.get(name, default).split(",") if value.strip()]


def configuration_map(name):
    try:
        result = json.loads(os.environ.get(name, "{}"))
        if not isinstance(result, dict) or not all(isinstance(value, str) for value in result.values()):
            raise ValueError
        return result
    except ValueError:
        raise ImproperlyConfigured(f"{name} must contain a JSON object of string values.") from None


def postgres_configuration(name, local_database):
    if ADC_ENV == "experience":
        url = require(name)
    else:
        url = os.environ.get(name, f"postgresql://adc_local@127.0.0.1/{local_database}")
    try:
        target = urlsplit(url)
        port = target.port or 5432
        options = parse_qs(target.query, strict_parsing=True)
        if (
            target.scheme not in {"postgres", "postgresql"} or not target.hostname
            or not target.username or not target.path.lstrip("/") or target.fragment
            or set(options) - {"sslmode"} or any(len(value) != 1 for value in options.values())
        ):
            raise ValueError
    except ValueError:
        raise ImproperlyConfigured(f"{name} must be a valid PostgreSQL connection URL.") from None
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(target.path.lstrip("/")),
        "USER": unquote(target.username),
        "PASSWORD": unquote(target.password or ""),
        "HOST": target.hostname,
        "PORT": port,
        "OPTIONS": {key: values[0] for key, values in options.items()},
    }


ADC_ENV = os.environ.get("ADC_ENV", "experience")
if ADC_ENV not in {"local", "test", "experience"}:
    raise ImproperlyConfigured("ADC_ENV must be local, test, or experience.")
SECRET_KEY = require("ADC_SECRET_KEY")
DEBUG = ADC_ENV == "local" and os.environ.get("ADC_DEBUG") == "1"

DATABASES = {
    "default": postgres_configuration("ADC_BUSINESS_DB_URL", "adc_business"),
    "runtime": postgres_configuration("ADC_RUNTIME_DB_URL", "adc_runtime"),
}
business, runtime = DATABASES["default"], DATABASES["runtime"]
if (business["HOST"], business["PORT"]) != (runtime["HOST"], runtime["PORT"]):
    raise ImproperlyConfigured("ADC business and runtime databases must use the same PostgreSQL instance.")
if business["NAME"] == runtime["NAME"]:
    raise ImproperlyConfigured("ADC business and runtime databases must have separate names.")
business["TEST"] = {"MIGRATE": False}

DATABASE_ROUTERS = ["config.db_router.ADCDatabaseRouter"]
TEST_RUNNER = "config.testing.ADCTestRunner"
CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"},
    "report_snapshots": {
        "BACKEND": "django.core.cache.backends.db.DatabaseCache",
        "LOCATION": "adc_report_snapshot",
    },
}

ALLOWED_HOSTS = csv_environment(
    "ADC_ALLOWED_HOSTS", "" if ADC_ENV == "experience" else "127.0.0.1,localhost,testserver"
)
if ADC_ENV == "experience" and not ALLOWED_HOSTS:
    raise ImproperlyConfigured("Set ADC_ALLOWED_HOSTS for the HTTPS experience environment.")

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
INSTALLED_APPS = [
    "django.contrib.sessions", "rest_framework", "adc.identity", "adc.reporting", "adc.scheduling", "adc.catalog",
    "adc.booking",
    "adc.payments",
    "adc.clinical",
    "adc.billing",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["adc.identity.authentication.ADCAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "UNAUTHENTICATED_USER": None,
    "EXCEPTION_HANDLER": "adc.common.http.exception_handler",
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
}
TIME_ZONE = "Asia/Shanghai"
LANGUAGE_CODE = "zh-hans"
USE_I18N = True
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
APPEND_SLASH = False

SESSION_COOKIE_NAME = "adc_session"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = ADC_ENV == "experience"
CSRF_COOKIE_SECURE = ADC_ENV == "experience"
CSRF_COOKIE_HTTPONLY = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https") if ADC_ENV == "experience" else None
SECURE_SSL_REDIRECT = ADC_ENV == "experience"
SECURE_HSTS_SECONDS = 31536000 if ADC_ENV == "experience" else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = ADC_ENV == "experience"
SECURE_HSTS_PRELOAD = ADC_ENV == "experience"
X_FRAME_OPTIONS = "DENY"
ADC_STAFF_PASSWORD_HASHES = configuration_map("ADC_STAFF_PASSWORD_HASHES")
ADC_MINI_SYNTHETIC_CODES = configuration_map("ADC_MINI_SYNTHETIC_CODES") if ADC_ENV in {"local", "test"} else {}
ADC_WECHAT_APP_ID = os.environ.get("ADC_WECHAT_APP_ID", "")
ADC_WECHAT_SECRET = os.environ.get("ADC_WECHAT_SECRET", "")
ADC_SIMULATION_OUTCOMES = configuration_map("ADC_SIMULATION_OUTCOMES")
ADC_SIMULATION_PAUSED = os.environ.get("ADC_SIMULATION_PAUSED") == "1"
ADC_WORK_CALENDARS_PATH = os.environ.get("ADC_WORK_CALENDARS_PATH", "")
ADC_MATERIAL_COSTS_PATH = os.environ.get("ADC_MATERIAL_COSTS_PATH", "")

ADC_ASSISTANT_DEEPSEEK_ENABLED = os.environ.get("ADC_ASSISTANT_DEEPSEEK_ENABLED") == "1"
ADC_ASSISTANT_SYNTHETIC_ENV = os.environ.get("ADC_ASSISTANT_SYNTHETIC_ENV", "")
ADC_ASSISTANT_SYNTHETIC_HOST = os.environ.get("ADC_ASSISTANT_SYNTHETIC_HOST", "")
ADC_ASSISTANT_SYNTHETIC_PORT = os.environ.get("ADC_ASSISTANT_SYNTHETIC_PORT", "")
ADC_ASSISTANT_SYNTHETIC_DB = os.environ.get("ADC_ASSISTANT_SYNTHETIC_DB", "")
ADC_DEEPSEEK_API_KEY = os.environ.get("ADC_DEEPSEEK_API_KEY", "").strip()
ADC_DEEPSEEK_MODEL = os.environ.get("ADC_DEEPSEEK_MODEL", "deepseek-flash")
