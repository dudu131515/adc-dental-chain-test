from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError
from django.contrib.auth.hashers import make_password
from django.db import connection, transaction
from django.test import Client, TestCase, override_settings

from adc.identity.models import AppRole, AuditLog, Clinic, Employee, EmployeeRole, UserAccount
from scripts.grant_db_access import configure_access


ACCESS = "/api/v1/admin/access"
CLINICS = "/api/v1/admin/clinics"


class AdminAccessTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        cls.clinic = Clinic.objects.create(clinic_no="ACCESS-A", clinic_name="合成甲门店", postal_address="合成甲地址")
        cls.other_clinic = Clinic.objects.create(
            clinic_no="ACCESS-B", clinic_name="合成乙门店", postal_address="合成乙地址",
        )
        cls.office, _ = AppRole.objects.get_or_create(
            role_code="HQ_ACCESS_ADMIN", defaults={"role_name": "总部权限管理"},
        )
        cls.quarter, _ = AppRole.objects.get_or_create(
            role_code="HQ_PERFORMANCE_REVIEW", defaults={"role_name": "总部绩效复核"},
        )
        cls.front, _ = AppRole.objects.get_or_create(role_code="FRONT_DESK", defaults={"role_name": "前台"})
        for code in ("DENTIST", "CLINIC_MANAGER", "HQ_SCHEDULER", "HQ_CATALOG", "HQ_OPERATIONS_QUERY"):
            AppRole.objects.get_or_create(role_code=code, defaults={"role_name": code})
        cls.admin = UserAccount.objects.create(
            employee=Employee.objects.create(employee_no="ACCESS-ADMIN", full_name="合成管理员"),
            login_identity="access-admin",
        )
        cls.target = UserAccount.objects.create(
            employee=Employee.objects.create(
                employee_no="ACCESS-TARGET", full_name="合成员工", phone="00000000001",
            ),
            login_identity="access-target",
        )
        cls.protected = UserAccount.objects.create(
            employee=Employee.objects.create(employee_no="ACCESS-PROTECTED", full_name="合成绩效人员"),
            login_identity="access-quarter",
        )
        EmployeeRole.objects.create(employee=cls.admin.employee, role=cls.office)
        EmployeeRole.objects.create(employee=cls.target.employee, role=cls.front, scope_clinic=cls.clinic)
        EmployeeRole.objects.create(employee=cls.protected.employee, role=cls.quarter, scope_clinic=cls.clinic)

    def sign_in(self, account):
        browser = Client()
        with override_settings(ADC_STAFF_PASSWORD_HASHES={account.login_identity: make_password("synthetic-password")}):
            login = browser.post(
                "/api/v1/auth/web/login", {"login_identity": account.login_identity, "password": "synthetic-password"},
                content_type="application/json",
            )
        self.assertEqual(login.status_code, 200, login.content)
        return browser

    def setUp(self):
        self.staff = self.sign_in(self.admin)

    def change_grant(self, *, role="FRONT_DESK", clinic=None, target=None, expected=False, granted=True,
                     key="grant-test", browser=None, reason="合成值班授权"):
        clinic_id = clinic if clinic is not None else self.other_clinic.pk
        target = target if target is not None else self.target.employee_id
        browser = browser or self.staff
        return browser.post(f"{ACCESS}/employees/{target}/grants", {
            "role_code": role, "clinic_id": clinic_id, "expected_granted": expected,
            "granted": granted, "reason": reason,
        }, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key)

    def change_status(self, target=None, *, expected="ACTIVE", status="INACTIVE", key="status-test"):
        target = target if target is not None else self.target.employee_id
        return self.staff.post(f"{ACCESS}/employees/{target}/account-status", {
            "expected_status": expected, "status": status, "reason": "合成账号状态更新",
        }, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key)

    def test_directory_projects_only_staff_and_clinic_business_details(self):
        result = self.staff.get(ACCESS)
        self.assertEqual(result.status_code, 200, result.content)
        directory = result.json()["data"]
        employees = {row["employee_id"]: row for row in directory["employees"]}
        target = employees[str(self.target.employee_id)]
        self.assertEqual(
            set(target), {"employee_id", "employee_no", "full_name", "employee_status", "account_status",
                          "can_manage_account", "can_manage_grants", "grants"},
        )
        self.assertTrue(target["can_manage_account"])
        self.assertFalse(employees[str(self.protected.employee_id)]["can_manage_account"])
        self.assertFalse(employees[str(self.admin.employee_id)]["can_manage_grants"])
        self.assertEqual(target["grants"], [{"role_code": "FRONT_DESK", "clinic_id": str(self.clinic.pk)}])
        self.assertCountEqual([row["role_code"] for row in directory["roles"]], [
            "FRONT_DESK", "DENTIST", "CLINIC_MANAGER", "HQ_SCHEDULER", "HQ_CATALOG", "HQ_OPERATIONS_QUERY",
        ])
        clinics = self.staff.get(CLINICS)
        self.assertEqual(clinics.status_code, 200, clinics.content)
        self.assertEqual(clinics.json()["data"]["items"][0], {
            "clinic_id": str(self.clinic.pk), "clinic_no": self.clinic.clinic_no, "name": self.clinic.clinic_name,
            "address": self.clinic.postal_address, "phone": None, "email": None, "status": "ACTIVE",
        })
        me = self.staff.get("/api/v1/auth/me").json()["data"]
        self.assertEqual(me["capabilities"], ["HQ_ACCESS_ADMIN"])
        self.assertEqual(me["role_clinic_ids"], {"HQ_ACCESS_ADMIN": None})
        self.assertEqual(me["clinics"], [])

    def test_scoped_admin_and_ordinary_employee_cannot_administer_other_clinics(self):
        other = self.sign_in(self.target)
        for route in (ACCESS, CLINICS):
            self.assertEqual(other.get(route).status_code, 403)
        self.assertEqual(self.change_grant(browser=other, target=self.protected.employee_id).status_code, 403)
        EmployeeRole.objects.create(employee=self.target.employee, role=self.office, scope_clinic=self.clinic)
        self.assertEqual(other.get(ACCESS).status_code, 403)
        self.assertEqual(self.change_grant(browser=other, target=self.protected.employee_id).status_code, 403)
        self.assertEqual(self.staff.get(f"/api/v1/clinics/{self.clinic.pk}/patient-directory").status_code, 403)

    def test_employee_history_is_admin_only_and_returns_safe_audit_fields(self):
        endpoint = f"{ACCESS}/employees/{self.target.employee_id}/history"
        self.assertEqual(self.sign_in(self.target).get(endpoint).status_code, 403)
        self.assertEqual(self.change_grant(reason="跨店支援").status_code, 200)
        self.assertEqual(self.change_status().status_code, 200)
        result = self.staff.get(endpoint)
        self.assertEqual(result.status_code, 200, result.content)
        items = result.json()["data"]["items"]
        self.assertEqual([row["action"] for row in items], ["EMPLOYEE_ACCOUNT_STATUS_CHANGED", "EMPLOYEE_SCOPE_CHANGED"])
        self.assertEqual(items[0]["before"], {"status": "ACTIVE"})
        self.assertEqual(items[1]["after"]["reason"], "跨店支援")
        self.assertEqual(items[1]["actor_account_id"], str(self.admin.pk))
        self.assertEqual(set(items[1]), {"audit_id", "action", "occurred_at", "actor_account_id", "before", "after"})

    def test_grant_validation_rejects_self_approval_deployment_roles_and_missing_clinic(self):
        for role in ("HQ_ACCESS_ADMIN", "HQ_PERFORMANCE_REVIEW", "INVENTED"):
            with self.subTest(role=role):
                result = self.change_grant(role=role)
                self.assertEqual(result.status_code, 403, result.content)
        self.assertEqual(self.change_grant(target=self.admin.employee_id).status_code, 403)
        self.assertEqual(self.change_grant(clinic="").status_code, 400)
        self.assertEqual(self.change_grant(clinic=2**63 - 1).status_code, 404)
        self.assertEqual(self.change_status(self.admin.employee_id).status_code, 403)
        self.assertEqual(self.change_status(self.protected.employee_id).status_code, 403)
        self.assertFalse(AuditLog.objects.filter(account_id=self.admin.pk).exists())

    def test_duplicate_grant_replays_original_result_and_stale_edit_is_rejected(self):
        first = self.change_grant()
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(self.change_grant(reason="不同原因").json()["error"]["code"], "IDEMPOTENCY_CONFLICT")
        stale = self.change_grant(key="grant-new-key")
        self.assertEqual(stale.status_code, 409, stale.content)
        self.assertEqual(stale.json()["error"]["code"], "STALE_ACCESS_STATE")
        revoke = self.change_grant(expected=True, granted=False, key="revoke-test")
        self.assertEqual(revoke.status_code, 200, revoke.content)
        self.assertEqual(first.json(), self.change_grant().json())
        self.assertFalse(EmployeeRole.objects.filter(
            employee=self.target.employee, role=self.front, scope_clinic=self.other_clinic,
        ).exists())
        updates = AuditLog.objects.filter(action="EMPLOYEE_SCOPE_CHANGED").order_by("pk")
        self.assertEqual(updates.count(), 2)
        audit = updates.first()
        self.assertEqual(audit.account_id, self.admin.pk)
        self.assertEqual(audit.target_id, self.target.employee_id)
        self.assertIsNotNone(audit.occurred_at)
        before = {
            "version": 1, "role_code": "FRONT_DESK", "clinic_id": str(self.other_clinic.pk), "granted": False,
        }
        self.assertEqual(audit.before_value, before)
        self.assertEqual(audit.after_value, {**before, "granted": True, "reason": "合成值班授权"})

    def test_revocation_and_account_status_apply_to_existing_sessions(self):
        target_browser = self.sign_in(self.target)
        directory = f"/api/v1/clinics/{self.clinic.pk}/patient-directory"
        self.assertEqual(target_browser.get(directory).status_code, 200)
        revoke = self.change_grant(clinic=self.clinic.pk, expected=True, granted=False, key="revoke-local")
        self.assertEqual(revoke.status_code, 200, revoke.content)
        self.assertEqual(target_browser.get(directory).status_code, 403)
        disabled = self.change_status()
        self.assertEqual(disabled.status_code, 200, disabled.content)
        self.assertEqual(target_browser.get("/api/v1/auth/me").status_code, 401)
        self.assertEqual(self.change_status(key="stale-status").status_code, 409)
        enabled = self.change_status(expected="INACTIVE", status="ACTIVE", key="enable")
        self.assertEqual(enabled.status_code, 200, enabled.content)
        self.assertEqual(self.change_status().json(), disabled.json())
        self.assertEqual(target_browser.get("/api/v1/auth/me").status_code, 200)
        self.assertEqual(AuditLog.objects.filter(action="EMPLOYEE_ACCOUNT_STATUS_CHANGED").count(), 2)
        audit = AuditLog.objects.filter(action="EMPLOYEE_ACCOUNT_STATUS_CHANGED").order_by("pk").first()
        self.assertEqual(audit.before_value, {"version": 1, "status": "ACTIVE"})
        self.assertEqual(audit.after_value, {
            "version": 1, "status": "INACTIVE", "reason": "合成账号状态更新",
        })
        EmployeeRole.objects.filter(employee=self.admin.employee, role=self.office).delete()
        self.assertEqual(self.staff.get(ACCESS).status_code, 403)
        self.assertEqual(self.change_status().status_code, 403)

    def test_restricted_db_role_can_write_access_changes_without_wider_updates(self):
        regular_staff = self.sign_in(self.target)
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("CREATE ROLE adc_test_admin_access_app NOLOGIN")
            configure_access(cursor, "business", "adc_test_admin_access_app")
            cursor.execute("SET LOCAL ROLE adc_test_admin_access_app")
            cursor.execute("""
                SELECT has_table_privilege(current_user, 'employee_role', 'UPDATE'),
                       has_table_privilege(current_user, 'user_account', 'UPDATE'),
                       has_column_privilege(current_user, 'user_account', 'login_identity', 'UPDATE'),
                       has_table_privilege(current_user, 'audit_log', 'UPDATE')
            """)
            self.assertEqual(cursor.fetchone(), (False, False, False, False))
            self.assertEqual(self.change_grant(browser=regular_staff).status_code, 403)
            self.assertEqual(self.change_status(self.protected.employee_id).status_code, 403)
            grant = self.change_grant()
            self.assertEqual(grant.status_code, 200, grant.content)
            revoke = self.change_grant(expected=True, granted=False, key="restricted-revoke")
            self.assertEqual(revoke.status_code, 200, revoke.content)
            disabled = self.change_status()
            self.assertEqual(disabled.status_code, 200, disabled.content)
            self.assertEqual(regular_staff.get("/api/v1/auth/me").status_code, 401)
            transaction.set_rollback(True)


    def test_initializer_cannot_revoke_the_last_effective_access_admin(self):
        with self.assertRaises(CommandError):
            call_command("configure_adc_scope", self.admin.employee.employee_no, "HQ_ACCESS_ADMIN", revoke=True)
        self.assertEqual(self.staff.get(ACCESS).status_code, 200)
        call_command("configure_adc_scope", self.target.employee.employee_no, "HQ_ACCESS_ADMIN")
        call_command("configure_adc_scope", self.admin.employee.employee_no, "HQ_ACCESS_ADMIN", revoke=True)
        self.assertEqual(self.staff.get(ACCESS).status_code, 403)
        self.assertEqual(self.sign_in(self.target).get(ACCESS).status_code, 200)

    def test_restricted_database_role_preserves_deployment_only_identity_writes(self):
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("CREATE ROLE adc_test_protected_scope_app NOLOGIN")
            configure_access(cursor, "business", "adc_test_protected_scope_app")
            cursor.execute("SET LOCAL ROLE adc_test_protected_scope_app")
            for statement, arguments in (
                ("DELETE FROM employee_role WHERE employee_id = %s AND role_id = %s",
                 [self.admin.employee_id, self.office.pk]),
                ("UPDATE user_account SET status = %s WHERE id = %s", ["INACTIVE", self.admin.pk]),
            ):
                with self.assertRaises(DatabaseError), transaction.atomic():
                    cursor.execute(statement, arguments)
            transaction.set_rollback(True)
