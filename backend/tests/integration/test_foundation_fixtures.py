from django.test import TestCase

from adc.identity.models import Clinic, EmployeeRole, Patient, UserAccount
from tests.fixtures.scenarios import load_synthetic_base


class FoundationFixturesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def test_synthetic_base_can_drive_the_two_clinic_permission_cases(self):
        clinic_ids = set(Clinic.objects.filter(clinic_no__startswith="ADC-DEMO").values_list("pk", flat=True))
        self.assertEqual(len(clinic_ids), 2)
        dentist_scopes = EmployeeRole.objects.filter(role__role_code="DENTIST").values_list("employee_id", "scope_clinic_id")
        self.assertEqual(len({dentist for dentist, _ in dentist_scopes}), 1)
        self.assertEqual({clinic for _, clinic in dentist_scopes}, clinic_ids)
        self.assertEqual(Patient.objects.count(), 2)
        self.assertEqual(UserAccount.objects.filter(patient__isnull=False).count(), 2)
        self.assertEqual(
            EmployeeRole.objects.filter(
                role__role_code="HQ_PERFORMANCE_CONFIRM", scope_clinic__isnull=True
            ).count(),
            1,
        )
