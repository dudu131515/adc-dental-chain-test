from datetime import timedelta

from django.contrib.auth.hashers import check_password, make_password
from django.db import DatabaseError, connection, transaction
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from adc.booking.models import SlotClaim
from adc.catalog.models import TreatmentType
from adc.identity.models import AppRole, AuditLog, Clinic, Employee, EmployeeRole, Patient, UserAccount
from adc.scheduling.models import Shift
from adc.scheduling.shift_service import qualified
from scripts.grant_db_access import configure_access


class MasterDataTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        cls.clinic = Clinic.objects.create(clinic_no="MASTER-HOME", clinic_name="合成门店", postal_address="合成地址")
        admin_role = AppRole.objects.create(role_code="HQ_ACCESS_ADMIN", role_name="权限管理")
        scheduling = AppRole.objects.create(role_code="HQ_SCHEDULER", role_name="总部排班")
        cls.admin, cls.dentist = [
            Employee.objects.create(employee_no=no, full_name=name, job_code=job, home_clinic=home)
            for no, name, job, home in (
                ("MASTER-ADMIN", "合成管理员", "HEADQUARTERS", None),
                ("MASTER-DENTIST", "合成牙医", "DENTIST", cls.clinic),
            )
        ]
        cls.admin_account = UserAccount.objects.create(employee=cls.admin, login_identity="master-admin")
        EmployeeRole.objects.create(employee=cls.admin, role=admin_role)
        EmployeeRole.objects.create(employee=cls.admin, role=scheduling)
        cls.ordinary = UserAccount.objects.create(employee=cls.dentist, login_identity="master-dentist")

    def setUp(self):
        self.staff = Client()
        password = "master-test-preview-only"
        with override_settings(ADC_STAFF_PASSWORD_HASHES={self.admin_account.login_identity: make_password(password)}):
            result = self.staff.post("/api/v1/auth/web/login", {
                "login_identity": self.admin_account.login_identity, "password": password,
            }, content_type="application/json")
        self.assertEqual(result.status_code, 200, result.content)

    def write(self, method, url, data, key="master-test"):
        return getattr(self.staff, method)(
            f"/api/v1/admin/{url}", data, content_type="application/json", HTTP_IDEMPOTENCY_KEY=key,
        )

    def test_clinic_status_remains_in_admin_but_disappears_from_booking_directory(self):
        created = self.write("post", "clinics", {"clinic_no": "MASTER", "name": "新门店", "address": "地址"})
        self.assertEqual(created.status_code, 201, created.content)
        clinic_id = created.json()["data"]["clinic_id"]
        booking_directory = "/api/v1/clinics"
        self.assertIn(clinic_id, {row["clinic_id"] for row in self.staff.get(booking_directory).json()["data"]["items"]})
        self.assertEqual(self.write("patch", f"clinics/{clinic_id}", {"status": "INACTIVE"}).status_code, 200)
        self.assertNotIn(clinic_id, {row["clinic_id"] for row in self.staff.get(booking_directory).json()["data"]["items"]})
        result = self.staff.get("/api/v1/admin/clinics").json()["data"]["items"]
        self.assertEqual(next(row for row in result if row["clinic_id"] == clinic_id)["status"], "INACTIVE")
        self.assertEqual(AuditLog.objects.filter(action="CLINIC_SAVED", target_id=clinic_id).count(), 2)

    def test_restricted_admin_can_create_login_and_retry_without_leaking_password(self):
        raw = "Synthetic-Office-78!"
        fields = {
            "employee_no": "MASTER-EMP", "full_name": "新员工", "job_code": "FRONT_DESK",
            "home_clinic_id": self.clinic.pk, "account": {"login_identity": "master-front", "password": raw},
        }
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("CREATE ROLE adc_test_master_data_app NOLOGIN")
            configure_access(cursor, "business", "adc_test_master_data_app")
            cursor.execute("SET LOCAL ROLE adc_test_master_data_app")
            created = self.write("post", "access/employees", fields)
            self.assertEqual(created.status_code, 201, created.content)
            replay = self.write("post", "access/employees", fields)
            self.assertEqual(replay.json(), created.json())
            employee = Employee.objects.get(employee_no="MASTER-EMP")
            account = UserAccount.objects.get(employee=employee)
            self.assertTrue(check_password(raw, account.staff_password_hash))
            self.assertNotIn(raw, str(list(AuditLog.objects.values_list("after_value", flat=True))))
            self.assertNotIn(raw, created.content.decode())
            login = Client().post("/api/v1/auth/web/login", fields["account"], content_type="application/json")
            self.assertEqual(login.status_code, 200, login.content)
            self.assertEqual(login.json()["data"]["capabilities"], [])
            transaction.set_rollback(True)

    def test_business_role_cannot_write_master_data_directly_or_with_ordinary_actor(self):
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("CREATE ROLE adc_test_master_data_restricted NOLOGIN")
            configure_access(cursor, "business", "adc_test_master_data_restricted")
            cursor.execute("SET LOCAL ROLE adc_test_master_data_restricted")
            with self.assertRaises(DatabaseError), transaction.atomic():
                cursor.execute("UPDATE clinic SET status = 'INACTIVE' WHERE clinic_id = %s", [self.clinic.pk])
            with self.assertRaises(DatabaseError), transaction.atomic():
                cursor.execute(
                    """SELECT adc_write_master_data(%s, 'clinic', %s, '{"status": "INACTIVE"}'::jsonb)""",
                    [self.ordinary.pk, self.clinic.pk],
                )
            with self.assertRaises(DatabaseError), transaction.atomic():
                cursor.execute(
                    "INSERT INTO user_account(employee_id, login_identity) VALUES (%s, 'bypass')",
                    [self.admin.pk],
                )
            transaction.set_rollback(True)

    def test_dentist_credential_changes_feed_the_existing_schedule_qualification_rule(self):
        qualification = self.write("post", "qualifications", {
            "qualification_code": "MASTER-CERT", "qualification_name": "合成资质",
        })
        self.assertEqual(qualification.status_code, 201, qualification.content)
        qualification_id = qualification.json()["data"]["qualification_id"]
        result = self.write("post", "dentist-qualifications", {
            "employee_id": self.dentist.pk, "qualification_id": qualification_id, "certificate_no": "TEST-01",
        })
        self.assertEqual(result.status_code, 201, result.content)
        credential_id = result.json()["data"]["credential_id"]
        begins = timezone.now() + timedelta(days=5)
        ends = begins + timedelta(hours=2)
        self.assertTrue(qualified(self.dentist.pk, qualification_id, begins, ends))
        edited = self.write("patch", f"dentist-qualifications/{credential_id}", {"valid_until": "2020-05-01"})
        self.assertEqual(edited.status_code, 200, edited.content)
        self.assertFalse(qualified(self.dentist.pk, qualification_id, begins, ends))
        self.assertEqual(self.write("patch", f"dentist-qualifications/{credential_id}", {
            "employee_id": self.admin.pk,
        }).status_code, 400)

    def test_chair_deactivation_preserves_hold_capacity_and_clinic_deactivation_releases_the_hold(self):
        chair = self.write("post", "chairs", {"clinic_id": self.clinic.pk, "chair_no": "MASTER-01", "chair_kind": "GENERAL"})
        self.assertEqual(chair.status_code, 201, chair.content)
        chair_route = "chairs/" + chair.json()["data"]["chair_id"]
        now = timezone.now()
        starts, ends = now + timedelta(hours=1), now + timedelta(hours=2)
        shift = Shift.objects.create(clinic=self.clinic, dentist=self.dentist, start_at=starts, end_at=ends, status="PUBLISHED")
        patient = Patient.objects.create(
            patient_no="MASTER-PATIENT", full_name="合成患者", birth_date="1990-01-01",
            billing_address="合成地址", phone="00000000000", emergency_name="合成联系人", emergency_phone="00000000000",
        )
        treatment = TreatmentType.objects.create(treatment_code="MASTER-TREATMENT", treatment_name="口腔检查", standard_unit="次")
        claim = SlotClaim.objects.create(
            patient=patient, clinic=self.clinic, dentist=self.dentist, shift=shift, requested_treatment_type=treatment,
            required_chair_kind="GENERAL", start_at=starts, end_at=ends, expires_at=now + timedelta(minutes=10), status="HOLD",
        )
        self.assertEqual(self.write("patch", chair_route, {"status": "INACTIVE"}).status_code, 409)
        self.assertEqual(self.write("patch", f"clinics/{self.clinic.pk}", {"status": "INACTIVE"}).status_code, 200)
        claim.refresh_from_db()
        self.assertEqual(claim.status, "RELEASED")
        stopped = self.write("patch", chair_route, {"status": "INACTIVE"})
        self.assertEqual(stopped.status_code, 200, stopped.content)
        restored = self.write("patch", chair_route, {"status": "AVAILABLE"})
        self.assertEqual(restored.json()["data"]["status"], "AVAILABLE")

    def test_effective_material_cost_replacement_keeps_prior_version(self):
        response = self.write("post", "materials", {
            "material_code": "M-NEW", "material_name": "新耗材", "standard_unit": "份",
        })
        self.assertEqual(response.status_code, 201, response.content)
        material_id = response.json()["data"]["material_id"]
        route = f"materials/{material_id}/costs"
        original = self.write("post", route, {"unit_cost": "5.00", "effective_from": "2024-01-01"})
        self.assertEqual(original.status_code, 201, original.content)
        new = {"unit_cost": "6.00", "effective_from": "2025-01-01"}
        self.assertEqual(self.write("post", route, new).status_code, 409)
        new.update(replace_cost_id=original.json()["data"]["cost_id"], replace_effective_to="2025-01-01")
        self.assertEqual(self.write("post", route, new).status_code, 201)
        history = self.staff.get(f"/api/v1/admin/{route}").json()["data"]["items"]
        self.assertEqual([(row["unit_cost"], row["effective_to"]) for row in history],
                         [("6.00", None), ("5.00", "2025-01-01")])
