"""Create synthetic ADC preview records in a new, dedicated local preview database."""
import json
from datetime import datetime, time, timedelta
from pathlib import Path

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone

from adc.booking.models import Appointment, AppointmentChange, DepositPayment, DepositRefund, SlotClaim
from adc.catalog.models import TreatmentPrice, TreatmentType
from adc.clinical.models import ChairUsage, DentistWorkSession, PatientAllergy, TreatmentItem, Visit
from adc.identity.audit import record_event
from adc.identity.models import Clinic, Employee, EmployeeRole, Patient, UserAccount
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.scheduling.models import DentalChair, Shift
from tests.fixtures.scenarios import load_synthetic_base


def seed():
    database = settings.DATABASES["default"]
    if settings.ADC_ENV != "local" or database["HOST"] != "127.0.0.1" or not database["NAME"].startswith("adc_workspace_preview_"):
        raise RuntimeError("A new dedicated local ADC preview database is required.")
    now = timezone.now()
    today = now.astimezone(BUSINESS_ZONE).date()
    roles = dict(UserAccount.objects.filter(employee_id__isnull=False).values_list("login_identity", "pk"))
    Clinic.objects.filter(pk=1).update(clinic_name="中心口腔门诊", postal_address="示例路 18 号 · 2 层")
    Clinic.objects.filter(pk=2).update(clinic_name="滨江口腔门诊", postal_address="示例大道 56 号 · 1 层")
    Employee.objects.filter(pk=1).update(full_name="林明远")
    doctor = Employee.objects.create(employee_no="ADC-PREVIEW-DOCTOR-2", full_name="周宁")
    grant = EmployeeRole.objects.filter(employee_id=1, role__role_code="DENTIST", scope_clinic_id=1).get()
    EmployeeRole.objects.create(employee=doctor, role_id=grant.role_id, scope_clinic_id=1)
    chairs = [DentalChair.objects.create(clinic_id=1, chair_no=f"A-{number:02d}") for number in range(1, 5)]
    DentalChair.objects.create(clinic_id=2, chair_no="B-01")
    for pk, name in enumerate(("陈晓雨", "孟子安"), 1):
        Patient.objects.filter(pk=pk).update(patient_no=f"ADC-P{pk:04d}", full_name=name)
    for number, name in enumerate(("赵青", "许言", "罗珊", "宋晨", "王安琪", "吴天", "程歌", "李嘉"), 3):
        Patient.objects.create(patient_no=f"ADC-P{number:04d}", full_name=name, birth_date="1998-06-01",
                               billing_address="合成地址", phone=f"0000000{number:04d}", emergency_name="合成联系人",
                               emergency_phone="00000000000")
    for patient in Patient.objects.all():
        record_event(account_id=roles["demo.front-a"], action="FRONT_DESK_PATIENT_REGISTERED", target_type="patient",
                     target_id=patient.pk, visible_fields=("clinic_id",), after={"clinic_id": "1"})
    PatientAllergy.objects.create(patient_id=1, allergen_name="乳胶", notes="合成核对样例")
    PatientAllergy.objects.create(patient_id=4, allergen_name="青霉素", notes="合成核对样例")
    projects = []
    for code, name, price in [("EXAM", "口腔检查", "80.00"), ("CLEAN", "洁牙护理", "180.00"), ("FILL", "树脂充填", "280.00")]:
        project = TreatmentType.objects.create(treatment_code=code, treatment_name=name, standard_unit="次",
                                                default_slot_minutes=30, required_chair_kind="GENERAL")
        projects.append(project)
        TreatmentPrice.objects.create(treatment_type=project, unit_price=price, effective_from=today-timedelta(days=90))

    def at(day, hour, minute=0):
        return datetime.combine(day, time(hour, minute), BUSINESS_ZONE)

    def shift(day, clinic, dentist, start, end):
        return Shift.objects.create(clinic_id=clinic, dentist_id=dentist, status="PUBLISHED", start_at=at(day,start),
                                    end_at=at(day,end), published_at=at(day - timedelta(days=3), 10))

    def appointment(number, active_shift, begins, patient, project, status, chair=None):
        start = begins
        end = start + timedelta(minutes=30)
        prior = start - timedelta(days=2)
        claim = SlotClaim.objects.create(patient_id=patient, clinic_id=active_shift.clinic_id, dentist_id=active_shift.dentist_id,
                                         shift=active_shift, requested_treatment_type=project, required_chair_kind="GENERAL",
                                         start_at=start, end_at=end, created_at=prior,
                                         status="CONFIRMED" if status in ("CONFIRMED","CHECKED_IN","IN_TREATMENT") else "RELEASED")
        paid = DepositPayment.objects.create(claim=claim, status="PAID", paid_at=prior)
        visit_started = status in ("IN_TREATMENT", "COMPLETED")
        row = Appointment.objects.create(appointment_no=f"ADC-DEMO-{number:03d}", claim=claim, deposit=paid,
                                         status=status, is_attended=visit_started, confirmed_at=prior)
        if status == "CANCELLED":
            AppointmentChange.objects.create(appointment=row, change_type="CANCEL", cancel_party="CLINIC",
                                             old_claim=claim, changed_by_id=2, changed_at=prior + timedelta(hours=5),
                                             reason="合成人工核实")
        if status == "NO_SHOW":
            AppointmentChange.objects.create(appointment=row, change_type="NO_SHOW", old_claim=claim,
                                             changed_by_id=2, changed_at=end, reason="合成人工核实")
        if status in ("CANCELLED", "NO_SHOW"):
            canceled = status == "CANCELLED"
            changed_at = prior + timedelta(hours=5) if canceled else end
            DepositRefund.objects.create(
                deposit=paid, refund_amount=paid.amount if canceled else 0,
                reason="CLINIC_CANCELLED" if canceled else "NO_SHOW",
                status="SUCCEEDED" if canceled else "RETAINED",
                idempotency_key=f"preview-fund-{number}", requested_at=changed_at,
                completed_at=changed_at if canceled else None,
            )
        if status in ("CHECKED_IN","IN_TREATMENT","COMPLETED"):
            audit = record_event(account_id=roles["demo.front-a"], action="APPOINTMENT_CHECKED_IN", target_type="appointment",
                                 target_id=row.pk, visible_fields=("claim_id","clinic_id","identity_confirmed"),
                                 after={"claim_id":str(claim.pk),"clinic_id":"1","identity_confirmed":True})
            type(audit).objects.filter(pk=audit.pk).update(occurred_at=min(now,start-timedelta(minutes=5)))
        completed = status == "COMPLETED"
        if chair:
            ChairUsage.objects.create(
                appointment=row, chair=chair, assigned_at=start if completed else min(now, start),
                released_at=end if completed else None,
            )
        if visit_started:
            begins_at = start if completed else min(now, start)
            visit = Visit.objects.create(appointment=row, main_dentist_id=active_shift.dentist_id,
                                         started_at=begins_at, ended_at=end if completed else None,
                                         status="COMPLETED" if completed else "IN_PROGRESS")
            DepositRefund.objects.create(deposit=paid, refund_amount=paid.amount, reason="VISIT_STARTED",
                                         status="SUCCEEDED", idempotency_key=f"preview-refund-{number}",
                                         requested_at=begins_at, completed_at=begins_at+timedelta(seconds=3))
            if completed:
                DentistWorkSession.objects.create(visit=visit, dentist_id=active_shift.dentist_id,
                                                  started_at=begins_at, ended_at=end, duration_minutes=30)
                price = TreatmentPrice.objects.get(treatment_type=project)
                item = TreatmentItem.objects.create(visit=visit, treatment_type=project, performing_dentist_id=active_shift.dentist_id,
                                                    units=1, unit_name_snapshot="次", unit_price_snapshot=price.unit_price,
                                                    amount=price.unit_price, recorded_at=end)
                fields = {"visit_id":str(visit.pk), "treatment_name":project.treatment_name, "price_id":str(price.pk),
                          "performed_at":start.isoformat(), "consent_id":None, "material_evidence":[]}
                record_event(account_id=roles["demo.dentist"], action="TREATMENT_ITEM_RECORDED", target_type="treatment_item",
                             target_id=item.pk, visible_fields=fields.keys(), after=fields)
        return row

    primary = shift(today,1,1,8,23)
    second = shift(today,1,doctor.pk,8,23)
    rows = [(8,30,3,0,"COMPLETED",chairs[0],primary),(9,0,1,1,"COMPLETED",chairs[0],primary),
            (9,30,5,2,"NO_SHOW",None,primary),(10,30,6,1,"CANCELLED",None,primary),
            (11,0,2,0,"CONFIRMED",None,second),(13,30,7,2,"CONFIRMED",None,second),
            (14,0,8,1,"CONFIRMED",None,second),(14,30,9,0,"CONFIRMED",None,second),
            (15,0,10,0,"IN_TREATMENT",chairs[1],second),(16,0,4,2,"CHECKED_IN",chairs[2],primary)]
    for number,(hour,minute,person,project,status,chair,work) in enumerate(rows,1):
        appointment(number,work,at(today,hour,minute),person,projects[project],status,chair)
    for days in range(1, 8):
        future = today+timedelta(days=days)
        upcoming = shift(future,1,1,9,12)
        shift(future,2,1,14,18)
        shift(future,1,doctor.pk,9,17)
        if days == 2:
            appointment(11,upcoming,at(future,10,30),1,projects[0],"CONFIRMED",None)
    start, end = today-timedelta(days=8), today+timedelta(days=21)
    days = [(start+timedelta(days=off)).isoformat() for off in range((end-start).days+1)]
    calendar = {key:{"valid_from":start.isoformat(),"valid_to":end.isoformat(),
                     "version":"ADC-preview","working_dates":days} for key in ("1","2")}
    Path(settings.ADC_WORK_CALENDARS_PATH).write_text(json.dumps(calendar),encoding="utf-8")
    return {login:make_password("ADC-preview-2026") for login in roles}


with transaction.atomic():
    if Clinic.objects.exists():
        raise RuntimeError("The preview database already contains records.")
    load_synthetic_base()
    hashes = seed()
print(json.dumps(hashes))
