from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from decimal import Decimal
from queue import Queue
from threading import Barrier
from time import perf_counter, sleep

from django.db import connection, connections, transaction
from django.test import SimpleTestCase, TransactionTestCase
from django.utils import timezone

from adc.booking.hold_service import create_hold, list_available
from adc.booking.models import DepositPayment, SlotClaim
from adc.catalog.models import TreatmentType
from adc.common.http import ApiProblem
from adc.common.idempotency import OperationKey
from adc.identity.models import AuditLog, Clinic, Employee, Patient, UserAccount
from adc.identity.permissions import Principal
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.models import DentalChair, Shift


def at(hhmm):
    return datetime.fromisoformat("2030-10-18T" + hhmm + ":00+08:00")


class ChairAllocationTests(SimpleTestCase):
    def test_one_chair_must_cover_the_entire_slot_even_if_each_half_has_capacity(self):
        from adc.booking.chair_capacity import Chair, Interval, Requirement, has_feasible_assignment

        chairs = [
            Chair(1, "GENERAL", (Interval(at("10:30"), at("11:00")),)),
            Chair(2, "GENERAL", (Interval(at("10:00"), at("10:30")),)),
        ]
        request = Requirement(0, at("10:00"), at("11:00"), "GENERAL")
        self.assertFalse(has_feasible_assignment(chairs, [request]))

    def test_mixed_chair_types_match_only_when_the_specific_chair_remains_free(self):
        from adc.booking.chair_capacity import Chair, Requirement, has_feasible_assignment

        chairs = [Chair(1, "SURGERY"), Chair(2, "GENERAL")]
        general = Requirement(12, at("10:00"), at("11:00"), None)
        special = Requirement(13, at("10:30"), at("11:00"), "SURGERY")
        self.assertTrue(has_feasible_assignment(chairs, [general, special]))
        assigned_to_special_chair = Requirement(12, at("10:00"), at("11:00"), None, fixed_chair_id=1)
        self.assertFalse(has_feasible_assignment(chairs, [assigned_to_special_chair, special]))


class CancellationAmountTests(SimpleTestCase):
    def test_patient_cancellation_thresholds_are_inclusive_at_the_approved_hours(self):
        from adc.booking.cancellation_service import patient_refund_amount

        start = at("09:00")
        examples = (
            (1440, "50.00"), (1439, "25.00"), (120, "25.00"), (119, "0.00"),
        )
        for minutes, refund in examples:
            with self.subTest(minutes=minutes):
                self.assertEqual(
                    patient_refund_amount(Decimal("50.00"), start, start - timedelta(minutes=minutes)), Decimal(refund),
                )


class FinalChairConcurrencyTests(TransactionTestCase):
    def test_two_dentists_competing_for_one_clinic_chair_create_one_hold(self):
        clinic = Clinic.objects.create(clinic_no="ADC-RACE-CHAIR", clinic_name="合成争用门店", postal_address="合成地址")
        other_clinic = Clinic.objects.create(clinic_no="ADC-RACE-OTHER", clinic_name="合成乙店", postal_address="合成地址")
        chair = DentalChair.objects.create(clinic=clinic, chair_no="ADC-RACE-ONE")
        project = TreatmentType.objects.create(
            treatment_code="ADC-RACE-PROJECT", treatment_name="合成争用项目", standard_unit="次", default_slot_minutes=30,
        )
        start = (timezone.now() + timedelta(days=1)).astimezone(BUSINESS_ZONE).replace(hour=10, minute=0, second=0, microsecond=0)
        finish = start + timedelta(minutes=30)
        fixtures = []
        for index in (1, 2):
            dentist = Employee.objects.create(employee_no=f"ADC-RACE-D{index}", full_name="合成牙医")
            patient = Patient.objects.create(
                patient_no=f"ADC-RACE-P{index}", full_name="合成患者", birth_date="1980-01-01", billing_address="合成地址",
                phone="000000000", emergency_name="合成联系人", emergency_phone="000000001",
            )
            account = UserAccount.objects.create(patient=patient, login_identity=f"synthetic-race-{index}")
            principal = Principal(account.pk, "patient", None, patient.pk, frozenset())
            shift = Shift.objects.create(clinic=clinic, dentist=dentist, start_at=start, end_at=finish, status="PUBLISHED")
            fields = {
                "clinic_id": clinic.pk, "patient_id": patient.pk, "dentist_id": dentist.pk, "shift_id": shift.pk,
                "treatment_type_id": project.pk, "start_at": start, "end_at": finish,
            }
            operation = OperationKey(account.pk, "create_hold", {"clinic_id": clinic.pk, "patient_id": patient.pk}, "race-same-chair")
            fixtures.append((principal, fields, operation, dentist, patient, account, shift))
        ready = Barrier(2, timeout=10)
        backends = Queue()

        def reserve(fixture):
            principal, fields, operation, *_ = fixture
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid()")
                    backends.put(cursor.fetchone()[0])
                ready.wait()
                begin = perf_counter()
                try:
                    hold, _, _ = create_hold(principal, fields, operation)
                    return hold.status, perf_counter() - begin
                except ApiProblem as problem:
                    return problem.code, perf_counter() - begin
            finally:
                connections.close_all()

        try:
            query_start = perf_counter()
            options = list_available(fixtures[0][0], clinic.pk, start.date(), project.pk)
            query_elapsed = perf_counter() - query_start
            self.assertEqual(len(options["items"]), 2)
            with ThreadPoolExecutor(max_workers=2) as workers:
                with transaction.atomic():
                    Clinic.objects.select_for_update().get(pk=clinic.pk)
                    attempts = [workers.submit(reserve, item) for item in fixtures]
                    ids = [backends.get(timeout=10) for _ in attempts]
                    observed = []
                    begin_wait = perf_counter()
                    while len(observed) < 2 and perf_counter() - begin_wait < 5:
                        with connection.cursor() as cursor:
                            cursor.execute("SELECT pg_stat_clear_snapshot()")
                            cursor.execute(
                                "SELECT wait_event FROM pg_stat_activity WHERE pid = ANY(%s) AND wait_event_type = 'Lock'",
                                [ids],
                            )
                            observed = [row[0] for row in cursor.fetchall()]
                        if len(observed) < 2:
                            sleep(0.01)
                    wait_elapsed = perf_counter() - begin_wait
                outcomes = [attempt.result(timeout=10) for attempt in attempts]
            self.assertEqual(len(observed), 2)
            self.assertCountEqual([status for status, _ in outcomes], ["HOLD", "RESOURCE_CONFLICT"])
            self.assertEqual(SlotClaim.objects.filter(clinic=clinic, status="HOLD").count(), 1)
            print(f"ADC final-chair query {query_elapsed:.4f}s, observed waits {observed} within {wait_elapsed:.4f}s. Attempts {outcomes}.")
        finally:
            AuditLog.objects.filter(account_id__in=[fixture[5].pk for fixture in fixtures]).delete()
            DepositPayment.objects.filter(claim__clinic=clinic).delete()
            SlotClaim.objects.filter(clinic=clinic).delete()
            for _, _, _, dentist, patient, account, shift in fixtures:
                shift.delete()
                account.delete()
                patient.delete()
                dentist.delete()
            chair.delete()
            project.delete()
            clinic.delete()
            other_clinic.delete()
