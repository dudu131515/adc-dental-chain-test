from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings

from adc.identity.models import AuditLog, Patient
from tests.fixtures.scenarios import load_synthetic_base


class RegistryTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()
        for patient in Patient.objects.order_by("pk"):
            AuditLog.objects.create(action="FRONT_DESK_PATIENT_REGISTERED", target_type="patient",
                                    target_id=patient.pk, after_value={"clinic_id": str(patient.pk)})

    def setUp(self):
        self.staff = Client()
        with override_settings(ADC_STAFF_PASSWORD_HASHES={"demo.front-a": make_password("registry-local-test")}):
            response = self.staff.post("/api/v1/auth/web/login",
                                       {"login_identity": "demo.front-a", "password": "registry-local-test"},
                                       content_type="application/json")
        self.assertEqual(response.status_code, 200)

    def test_scoped_directory_search_paging_and_minimum_profile(self):
        patient = Patient.objects.get(pk=1)
        directory = "/api/v1/clinics/1/patient-directory"
        result = self.staff.get(directory, {"q": patient.phone})
        self.assertEqual(result.status_code, 200, result.content)
        data = result.json()["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual([row["patient_id"] for row in data["items"]], ["1"])
        self.assertEqual(self.staff.get(directory, {"page": 0}).status_code, 400)
        details = self.staff.get("/api/v1/clinics/1/patients/1").json()["data"]
        self.assertEqual(details["appointments"], [])
        self.assertEqual(set(details["patient"]), {"patient_id", "patient_no", "full_name", "phone", "birth_date"})
        self.assertEqual(self.staff.get("/api/v1/clinics/1/patients/2").status_code, 404)
        self.assertIn(self.staff.get("/api/v1/clinics/2/patients/2").status_code, (403, 404))
