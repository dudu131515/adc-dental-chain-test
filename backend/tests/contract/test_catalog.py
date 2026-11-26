from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings

from adc.identity.models import EmployeeRole
from tests.fixtures.scenarios import load_synthetic_base


class CatalogContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def setUp(self):
        password = "catalog-synthetic-password"
        password_hash = make_password(password)
        config = override_settings(
            ADC_STAFF_PASSWORD_HASHES={"demo.catalog": password_hash, "demo.front-a": password_hash},
            ADC_MINI_SYNTHETIC_CODES={"adc-catalog-patient": "adc-demo-patient-a"},
        )
        config.enable()
        self.addCleanup(config.disable)
        self.catalog = Client()
        self.front = Client()
        for client, user in ((self.catalog, "demo.catalog"), (self.front, "demo.front-a")):
            response = self.post(client, "/auth/web/login", {"login_identity": user, "password": password})
            self.assertEqual(response.status_code, 200, response.content)

    def post(self, client, path, data):
        return client.post("/api/v1" + path, data, content_type="application/json")

    def create_treatment(self):
        payload = {
            "treatment_code": "ADC-DEMO-CHECK", "treatment_name": "合成初诊检查",
            "standard_unit": "次", "default_slot_minutes": 30,
        }
        denied = self.post(self.front, "/catalog/treatments", payload)
        self.assertEqual(denied.status_code, 403, denied.content)
        created = self.post(self.catalog, "/catalog/treatments", payload)
        self.assertEqual(created.status_code, 201, created.content)
        return created.json()["data"]["treatment_type_id"]

    def test_prices_reject_overlap_and_new_versions_preserve_prior_price(self):
        treatment = self.create_treatment()
        route = "/catalog/treatments/" + treatment + "/prices"
        first = self.post(self.catalog, route, {"unit_price": "120.00", "effective_from": "2030-01-01"})
        self.assertEqual(first.status_code, 201, first.content)
        first_version = first.json()["data"]["price_id"]
        overlap = self.post(self.catalog, route, {"unit_price": "130.00", "effective_from": "2030-07-01"})
        self.assertEqual(overlap.status_code, 409, overlap.content)
        second = self.post(self.catalog, route, {
            "unit_price": "130.00", "effective_from": "2030-07-01",
            "replace_price_id": first_version, "replace_effective_to": "2030-07-01",
        })
        self.assertEqual(second.status_code, 201, second.content)
        prices = self.catalog.get("/api/v1" + route).json()["data"]["items"]
        self.assertEqual(
            {row["effective_from"]: (row["unit_price"], row["effective_to"]) for row in prices},
            {"2030-01-01": ("120.00", "2030-07-01"), "2030-07-01": ("130.00", None)},
        )

    def test_patient_sees_only_active_booking_projection_and_cannot_edit(self):
        treatment = self.create_treatment()
        patient = Client()
        login = self.post(patient, "/auth/mini/login", {"code": "adc-catalog-patient"})
        self.assertEqual(login.status_code, 200, login.content)
        header = {"HTTP_AUTHORIZATION": "Bearer " + login.json()["data"]["token"]}
        reply = patient.get("/api/v1/catalog/treatments", **header)
        self.assertEqual(reply.status_code, 200, reply.content)
        item = reply.json()["data"]["items"][0]
        self.assertEqual(item["treatment_type_id"], treatment)
        self.assertEqual(item["default_slot_minutes"], 30)
        self.assertNotIn("unit_price", item)
        denied = patient.patch("/api/v1/catalog/treatments/" + treatment, {"active": False}, content_type="application/json", **header)
        self.assertEqual(denied.status_code, 403, denied.content)

    def test_clinic_catalog_grant_can_read_but_cannot_change_chain_wide_catalog(self):
        treatment = self.create_treatment()
        EmployeeRole.objects.filter(employee_id=7, role__role_code="HQ_CATALOG").update(scope_clinic_id=1)
        treatments_path = "/catalog/treatments"
        detail_path = f"{treatments_path}/{treatment}"
        prices_path = f"{detail_path}/prices"
        for path in (treatments_path, prices_path):
            self.assertEqual(self.catalog.get("/api/v1" + path).status_code, 200)
        payload = {"treatment_code": "ADC-GLOBAL", "treatment_name": "合成标准", "standard_unit": "次"}
        self.assertEqual(self.post(self.catalog, treatments_path, payload).status_code, 403)
        updated = self.catalog.patch("/api/v1" + detail_path, {"active": False}, content_type="application/json")
        self.assertEqual(updated.status_code, 403, updated.content)
        price = self.post(self.catalog, prices_path, {"unit_price": "99.00", "effective_from": "2030-01-01"})
        self.assertEqual(price.status_code, 403, price.content)
