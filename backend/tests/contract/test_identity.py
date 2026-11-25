from django.contrib.auth.hashers import make_password
from django.core.management import call_command
from django.test import Client, TestCase, override_settings

from adc.identity.models import AppRole, AuditLog, Clinic, Employee, EmployeeRole, UserAccount


class IdentityContractTests(TestCase):
    databases = {"default", "runtime"}

    def setUp(self):
        self.clinic = Clinic.objects.create(clinic_no="AUTH", clinic_name="合成门店", postal_address="合成地址")
        self.employee = Employee.objects.create(employee_no="AUTH-01", full_name="合成前台")
        self.role = AppRole.objects.create(role_code="FRONT_DESK", role_name="前台")
        EmployeeRole.objects.create(employee=self.employee, role=self.role, scope_clinic=self.clinic)
        self.account = UserAccount.objects.create(employee=self.employee, login_identity="front-demo")
        config = override_settings(
            ADC_STAFF_PASSWORD_HASHES={"front-demo": make_password("synthetic-password")},
            ADC_MINI_SYNTHETIC_CODES={"synthetic-code": "synthetic-openid"},
        )
        config.enable()
        self.addCleanup(config.disable)

    def test_browser_csrf_session_and_logout_are_effective_in_same_browser(self):
        staff = Client(enforce_csrf_checks=True)
        credentials = {"login_identity": "front-demo", "password": "synthetic-password"}
        self.assertEqual(staff.post("/api/v1/auth/web/login", credentials, content_type="application/json").status_code, 403)
        csrf_response = staff.get("/api/v1/auth/web/csrf")
        self.assertEqual(csrf_response.status_code, 200)
        csrf = csrf_response.json()["data"]["csrf_token"]
        response = staff.post("/api/v1/auth/web/login", credentials, content_type="application/json", HTTP_X_CSRFTOKEN=csrf)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.cookies["adc_session"]["httponly"])
        identity = staff.get("/api/v1/auth/me").json()["data"]
        self.assertEqual(identity["account_id"], str(self.account.pk))
        self.assertEqual([row["clinic_id"] for row in identity["clinics"]], [str(self.clinic.pk)])
        self.assertEqual(staff.post("/api/v1/auth/logout").status_code, 403)
        refreshed_csrf = staff.get("/api/v1/auth/web/csrf").json()["data"]["csrf_token"]
        self.assertEqual(staff.post("/api/v1/auth/logout", HTTP_X_CSRFTOKEN=refreshed_csrf).status_code, 204)
        self.assertEqual(staff.get("/api/v1/auth/me").status_code, 401)

    def test_miniprogram_only_binds_the_identity_supplied_by_the_server(self):
        patient = Client()
        self.assertEqual(patient.post("/api/v1/auth/mini/login", {"openid": "synthetic-openid"}, content_type="application/json").status_code, 400)
        login = patient.post("/api/v1/auth/mini/login", {"code": "synthetic-code"}, content_type="application/json").json()["data"]
        profile_as_bearer = {"HTTP_AUTHORIZATION": f"Bearer {login['profile_token']}"}
        self.assertEqual(patient.get("/api/v1/auth/me", **profile_as_bearer).status_code, 401)
        profile = {
            "profile_token": login["profile_token"],
            "full_name": "合成患者",
            "birth_date": "2000-01-01",
            "billing_address": "示例地址",
            "phone": "00000000000",
            "email": None,
            "emergency_name": "合成联系人",
            "emergency_phone": "00000000001",
        }
        first = patient.post("/api/v1/auth/mini/bind-profile", profile, content_type="application/json")
        repeat = patient.post("/api/v1/auth/mini/bind-profile", profile, content_type="application/json")
        self.assertIn(first.status_code, (200, 201))
        self.assertEqual(repeat.status_code, 200)
        first_body, repeat_body = first.json()["data"], repeat.json()["data"]
        self.assertEqual(first_body["patient_id"], repeat_body["patient_id"])
        self.assertEqual(UserAccount.objects.filter(patient_id=first_body["patient_id"]).count(), 1)
        bearer = {"HTTP_AUTHORIZATION": f"Bearer {repeat_body['token']}"}
        self.assertEqual(patient.get("/api/v1/auth/me", **bearer).json()["data"]["patient_id"], first_body["patient_id"])
        self.assertEqual(patient.post("/api/v1/auth/logout", **bearer).status_code, 204)
        self.assertEqual(patient.get("/api/v1/auth/me", **bearer).status_code, 401)

    def test_active_session_observes_grant_revocation_and_retains_minimal_evidence(self):
        staff = Client()
        credentials = {"login_identity": "front-demo", "password": "synthetic-password"}
        login = staff.post("/api/v1/auth/web/login", credentials, content_type="application/json")
        self.assertEqual(login.status_code, 200)
        self.assertEqual(staff.get("/api/v1/auth/me").json()["data"]["capabilities"], ["FRONT_DESK"])
        call_command(
            "configure_adc_scope", self.employee.employee_no, self.role.role_code,
            clinic_no=self.clinic.clinic_no, revoke=True, verbosity=0,
        )
        self.assertEqual(staff.get("/api/v1/auth/me").json()["data"]["clinics"], [])
        entry = AuditLog.objects.get(action="EMPLOYEE_SCOPE_CHANGED", target_id=self.employee.pk)
        self.assertEqual(entry.after_value, {
            "version": 1, "role_code": "FRONT_DESK", "clinic_id": str(self.clinic.pk), "granted": False,
        })
        UserAccount.objects.filter(pk=self.account.pk).update(status="INACTIVE")
        self.assertEqual(staff.get("/api/v1/auth/me").status_code, 401)
