from datetime import datetime

from django.test import TestCase

from adc.identity.models import Clinic
from adc.scheduling.day_capacity import unavailable_chair_periods
from adc.scheduling.models import DentalChair, DentalChairUnavailability


class DayChairCapacityTests(TestCase):
    def test_only_simultaneous_outages_of_all_available_chairs_block_the_day(self):
        clinic = Clinic.objects.create(clinic_no="CLOCK", clinic_name="排班合成门店", postal_address="示例")
        def clock(hour):
            return datetime.fromisoformat(f"2035-06-04T{hour:02}:00:00+08:00")

        chairs = [DentalChair.objects.create(clinic=clinic, chair_no=number) for number in ("1","2")]
        DentalChair.objects.create(clinic=clinic, chair_no="3", status="INACTIVE")
        for chair, start, end in [(chairs[0],9,12), (chairs[1],10,11)]:
            DentalChairUnavailability.objects.create(chair=chair,start_at=clock(start),end_at=clock(end),reason="合成维护")
        result = unavailable_chair_periods(clinic.pk, clock(8), clock(18))
        self.assertEqual(len(result), 1)
        self.assertEqual(datetime.fromisoformat(result[0]["start_at"]), clock(10))
        self.assertEqual(datetime.fromisoformat(result[0]["end_at"]), clock(11))
