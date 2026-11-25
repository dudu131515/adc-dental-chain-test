from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from adc.identity.audit import record_event
from adc.identity.models import AppRole, Clinic, Employee, EmployeeRole
from adc.identity.permissions import HQ_ROLES, LOCAL_ROLES


class Command(BaseCommand):
    help = "Maintain an ADC employee's role scope using the authorized provisioning account."

    def add_arguments(self, parser):
        parser.add_argument("employee_no")
        parser.add_argument("role_code", choices=sorted(LOCAL_ROLES | HQ_ROLES))
        parser.add_argument("--clinic-no")
        parser.add_argument("--actor-account-id", type=int)
        parser.add_argument("--revoke", action="store_true")

    def handle(self, *, employee_no, role_code, clinic_no, actor_account_id, revoke, **options):
        if role_code in LOCAL_ROLES and not clinic_no:
            raise CommandError("Clinic-scoped roles require --clinic-no.")
        with transaction.atomic():
            self.change_scope(employee_no, role_code, clinic_no, actor_account_id, revoke)

    def change_scope(self, employee_no, role_code, clinic_no, actor_account_id, revoke):
        try:
            employee = Employee.objects.select_for_update().get(employee_no=employee_no)
            role = AppRole.objects.get(role_code=role_code)
            clinic = Clinic.objects.get(clinic_no=clinic_no) if clinic_no else None
        except (Employee.DoesNotExist, AppRole.DoesNotExist, Clinic.DoesNotExist) as exc:
            raise CommandError("The employee, role, or clinic does not exist.") from exc

        grants = EmployeeRole.objects.filter(employee=employee, role=role, scope_clinic=clinic)
        existing = grants.first()
        if (existing is None and revoke) or (existing is not None and not revoke):
            return
        if revoke:
            existing.delete()
        else:
            EmployeeRole.objects.create(employee=employee, role=role, scope_clinic=clinic)
        target = {"role_code": role_code, "clinic_id": str(clinic.pk) if clinic else None}
        record_event(
            account_id=actor_account_id,
            action="EMPLOYEE_SCOPE_CHANGED",
            target_type="employee",
            target_id=employee.pk,
            visible_fields=("role_code", "clinic_id", "granted"),
            before={**target, "granted": revoke},
            after={**target, "granted": not revoke},
        )
