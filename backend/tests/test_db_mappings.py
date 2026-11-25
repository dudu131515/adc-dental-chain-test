from django.apps import apps
from django.db import IntegrityError, connections, transaction
from django.test import SimpleTestCase, TestCase


IDENTITY_MODELS = {
    "Employee": "employee",
    "Clinic": "clinic",
    "AppRole": "app_role",
    "EmployeeRole": "employee_role",
    "Patient": "patient",
    "UserAccount": "user_account",
    "AuditLog": "audit_log",
}
DOMAIN_MODELS = {
    "identity": IDENTITY_MODELS,
    "scheduling": {
        "Qualification": "qualification", "EmployeeQualification": "employee_qualification",
        "ShiftDemand": "shift_demand", "Shift": "shift", "DentalChair": "dental_chair",
        "DentalChairUnavailability": "dental_chair_unavailability",
    },
    "catalog": {"TreatmentType": "treatment_type", "TreatmentPrice": "treatment_price"},
    "booking": {
        "SlotClaim": "slot_claim", "DepositPayment": "deposit_payment", "Appointment": "appointment",
        "AppointmentChange": "appointment_change", "DepositRefund": "deposit_refund",
        "AppointmentRequestedTreatment": "appointment_requested_treatment",
    },
    "reporting": {
        "PerformancePeriod": "performance_period", "PerformanceRevision": "performance_revision",
        "OperatingExpense": "operating_expense", "ExpenseAllocation": "expense_allocation",
        "DentistPerformance": "dentist_performance", "CompanyPerformance": "company_performance",
    },
    "clinical": {
        "PatientAllergy": "patient_allergy", "Visit": "visit", "ChairUsage": "chair_usage",
        "DentistWorkSession": "dentist_work_session", "TreatmentItem": "treatment_item",
        "Material": "material", "MaterialUsage": "material_usage",
    },
    "billing": {
        "Invoice": "invoice", "InvoiceLine": "invoice_line", "InvoicePayment": "invoice_payment",
        "TreatmentCorrection": "treatment_correction", "CorrectionApproval": "correction_approval",
        "InvoiceAdjustment": "invoice_adjustment",
    },
}


class MappingOwnershipTests(SimpleTestCase):
    def test_django_models_leave_business_ddl_unmanaged(self):
        for app, models in DOMAIN_MODELS.items():
            with self.subTest(app=app):
                self.assertTrue(apps.is_installed("adc." + app))
                for name, expected_table in models.items():
                    metadata = apps.get_model(app, name)._meta
                    self.assertFalse(metadata.managed)
                    self.assertEqual(metadata.db_table, expected_table)


class IdentityFieldTests(TestCase):
    def test_fields_match_the_columns_installed_by_the_active_sql(self):
        tables = [(app, model, table) for app, models in DOMAIN_MODELS.items() for model, table in models.items()]
        with connections["default"].cursor() as cursor:
            for app, model_name, table in tables:
                cursor.execute(
                    """
                    SELECT column_name, is_nullable, character_maximum_length
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = %s
                    """,
                    [table],
                )
                database_columns = {column: (nullable == "YES", limit)
                                    for column, nullable, limit in cursor.fetchall()}
                fields = apps.get_model(app, model_name)._meta.local_fields
                with self.subTest(table=table):
                    self.assertEqual({field.column for field in fields}, set(database_columns))
                    for field in fields:
                        nullable, limit = database_columns[field.column]
                        self.assertEqual(field.null, nullable, field.column)
                        if limit is not None:
                            self.assertEqual(field.max_length, limit, field.column)

    def test_database_rejects_unassigned_accounts_and_duplicate_unscoped_role(self):
        employee = apps.get_model("identity", "Employee").objects.create(
            employee_no="ADC-U-TEST-1", full_name="合成员工",
        )
        role = apps.get_model("identity", "AppRole").objects.create(
            role_code="HQ_SCHEDULER", role_name="合成总部排班",
        )
        account = apps.get_model("identity", "UserAccount")
        grants = apps.get_model("identity", "EmployeeRole")
        with self.assertRaises(IntegrityError), transaction.atomic():
            account.objects.create(login_identity="missing-subject")
        grants.objects.create(employee=employee, role=role, scope_clinic=None)
        with self.assertRaises(IntegrityError), transaction.atomic():
            grants.objects.create(employee=employee, role=role, scope_clinic=None)
