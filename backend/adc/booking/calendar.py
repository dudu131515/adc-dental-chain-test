from datetime import date, datetime, time
import json
from pathlib import Path

from django.conf import settings

from adc.common.http import ApiProblem
from adc.reporting.period_locks import BUSINESS_ZONE


def change_cutoff(clinic_id, appointment_start):
    path = settings.ADC_WORK_CALENDARS_PATH
    service_date = appointment_start.astimezone(BUSINESS_ZONE).date()
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8")) if path else {}
        approved = document[str(clinic_id)]
        first, last = (date.fromisoformat(approved[key]) for key in ("valid_from", "valid_to"))
        if not first <= service_date <= last:
            raise ValueError
        prior = max(day for day in map(date.fromisoformat, approved["working_dates"]) if first <= day < service_date)
        version = approved["version"]
        if not isinstance(version, str) or not version.strip():
            raise ValueError
    except (OSError, KeyError, TypeError, ValueError):
        raise ApiProblem(
            409, "CALENDAR_UNAVAILABLE", "缺少覆盖本次预约的门店核准工作日历，请联系门店。",
        ) from None
    return datetime.combine(prior, time(20), BUSINESS_ZONE), version
