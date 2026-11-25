from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Barrier

from django.db import connections
from django.test import TransactionTestCase

from adc.common.http import ApiProblem
from adc.identity.models import AppRole, AuditLog, Clinic, Employee, EmployeeRole, UserAccount
from adc.identity.permissions import Principal
from adc.scheduling.models import Shift
from adc.scheduling.shift_service import publish_shift


class ScheduleConcurrencyTests(TransactionTestCase):
    def test_two_connections_cannot_publish_overlapping_shifts_for_one_dentist(self):
        scheduler = Employee.objects.create(employee_no="SCHED-RACE-ACTOR", full_name="合成排班员")
        account = UserAccount.objects.create(employee=scheduler, login_identity="sched-race-actor")
        actor = Principal(account.pk, "staff", scheduler.pk, None, frozenset({("HQ_SCHEDULER", None)}))
        dentist = Employee.objects.create(employee_no="SCHED-RACE-DENTIST", full_name="合成牙医")
        clinic = Clinic.objects.create(clinic_no="SCHED-RACE", clinic_name="合成门店", postal_address="合成地址")
        role, created = AppRole.objects.get_or_create(role_code="DENTIST", defaults={"role_name": "合成牙医"})
        grant = EmployeeRole.objects.create(employee=dentist, scope_clinic=clinic, role=role)
        shifts = [
            Shift.objects.create(
                clinic=clinic, dentist=dentist, status="ACCEPTED",
                start_at=datetime.fromisoformat("2030-11-01T09:00:00+08:00"),
                end_at=datetime.fromisoformat("2030-11-01T10:00:00+08:00"),
            )
            for _ in range(2)
        ]
        ready = Barrier(2, timeout=10)

        def publish(item):
            try:
                ready.wait()
                return publish_shift(actor, item, None, None).status
            except ApiProblem as error:
                return error.code
            finally:
                connections.close_all()

        try:
            with ThreadPoolExecutor(max_workers=2) as workers:
                outcomes = list(workers.map(publish, shifts))
            self.assertCountEqual(outcomes, ["PUBLISHED", "SHIFT_CONFLICT"])
            self.assertEqual(Shift.objects.filter(pk__in=[shift.pk for shift in shifts], status="PUBLISHED").count(), 1)
        finally:
            AuditLog.objects.filter(account=account).delete()
            Shift.objects.filter(pk__in=[shift.pk for shift in shifts]).delete()
            grant.delete()
            if created:
                role.delete()
            clinic.delete()
            dentist.delete()
            account.delete()
            scheduler.delete()
