"""Create synthetic ADC preview records in a new, dedicated local preview database."""
import json
from datetime import datetime, time, timedelta
from decimal import Decimal
from pathlib import Path

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone

from adc.billing.models import CorrectionApproval, Invoice, InvoiceAdjustment, InvoiceLine, InvoicePayment, TreatmentCorrection
from adc.booking.models import Appointment, AppointmentChange, DepositPayment, DepositRefund, SlotClaim
from adc.catalog.models import TreatmentPrice, TreatmentType
from adc.clinical.models import ChairUsage, DentistWorkSession, Material, MaterialCost, PatientAllergy, TreatmentItem, Visit
from adc.identity.audit import record_event
from adc.identity.models import AppRole, Clinic, Employee, EmployeeRole, Patient, UserAccount
from adc.common.idempotency import OperationKey
from adc.identity.permissions import ACCESS_ADMIN_ROLE, HQ_ROLES, current_principal
from adc.reporting.models import OperatingExpense
from adc.reporting.period_locks import BUSINESS_ZONE, lock_period
from adc.reporting.quarter_versions import calculate, confirm, review
from adc.scheduling.models import DentalChair, Shift, ShiftDemand
from tests.fixtures.scenarios import load_synthetic_base


def seed():
    database = settings.DATABASES["default"]
    if settings.ADC_ENV != "local" or database["HOST"] != "127.0.0.1" or not database["NAME"].startswith("adc_workspace_preview_"):
        raise RuntimeError("A new dedicated local ADC preview database is required.")
    now = timezone.now()
    today = now.astimezone(BUSINESS_ZONE).date()
    access_role = AppRole.objects.create(role_code=ACCESS_ADMIN_ROLE, role_name="总部权限管理")
    report_role = AppRole.objects.get(role_code="HQ_OPERATIONS_QUERY")
    for suffix, label, role, clinic in (
        ("access", "合成总部权限管理员", access_role, None),
        ("reports-a", "合成中心店经营查询", report_role, 1),
    ):
        employee = Employee.objects.create(employee_no="ADC-DEMO-" + suffix.upper(), full_name=label,
                                           job_code=Employee.Job.HEADQUARTERS)
        UserAccount.objects.create(employee=employee, login_identity="demo." + suffix)
        EmployeeRole.objects.create(employee=employee, role=role, scope_clinic_id=clinic)
    profiles = (
        ("DENTIST", Employee.Job.DENTIST, 1),
        ("FRONT-A", Employee.Job.FRONT_DESK, 1), ("FRONT-B", Employee.Job.FRONT_DESK, 2),
        ("MANAGER-A", Employee.Job.CLINIC_MANAGER, 1), ("MANAGER-B", Employee.Job.CLINIC_MANAGER, 2),
    )
    for suffix, job, clinic in profiles:
        Employee.objects.filter(employee_no="ADC-DEMO-" + suffix).update(job_code=job, home_clinic_id=clinic)
    office = Employee.objects.filter(employee_no__in=[
        "ADC-DEMO-SCHEDULER", "ADC-DEMO-CATALOG", "ADC-DEMO-REPORTS", "ADC-DEMO-CALCULATE",
        "ADC-DEMO-REVIEW", "ADC-DEMO-CONFIRM",
    ])
    office.update(job_code=Employee.Job.HEADQUARTERS)
    headquarters = office.get(employee_no="ADC-DEMO-SCHEDULER")
    for role in AppRole.objects.filter(role_code__in=HQ_ROLES):
        EmployeeRole.objects.get_or_create(employee=headquarters, role=role, scope_clinic=None)
    roles = dict(UserAccount.objects.filter(employee_id__isnull=False).values_list("login_identity", "pk"))
    Clinic.objects.filter(pk=1).update(clinic_name="中心口腔门诊", postal_address="示例路 18 号 · 2 层")
    Clinic.objects.filter(pk=2).update(clinic_name="滨江口腔门诊", postal_address="示例大道 56 号 · 1 层")
    Employee.objects.filter(pk=1).update(full_name="林明远")
    doctor = Employee.objects.create(employee_no="ADC-PREVIEW-DOCTOR-2", full_name="周宁",
                                     job_code=Employee.Job.DENTIST, home_clinic_id=1)
    second_doctor_account = UserAccount.objects.create(employee=doctor, login_identity="demo.dentist-center2")
    roles[second_doctor_account.login_identity] = second_doctor_account.pk
    grant = EmployeeRole.objects.filter(employee_id=1, role__role_code="DENTIST", scope_clinic_id=1).get()
    EmployeeRole.objects.create(employee=doctor, role_id=grant.role_id, scope_clinic_id=1)
    chairs = [DentalChair.objects.create(clinic_id=1, chair_no=f"A-{number:02d}") for number in range(1, 5)]
    branch_chair = DentalChair.objects.create(clinic_id=2, chair_no="B-01")
    for code, name, unit, cost in (
        ("ADC-MAT-RESIN", "光固化复合树脂", "克", "48.00"),
        ("ADC-MAT-SALIVA", "一次性吸唾管", "支", "1.50"),
        ("ADC-MAT-POLISH", "牙面抛光膏", "克", "6.50"),
    ):
        material = Material.objects.create(material_code=code, material_name=name, standard_unit=unit)
        MaterialCost.objects.create(material=material, unit_cost=cost, effective_from=today - timedelta(days=120))
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
                                             changed_by_id=roles["demo.front-a" if active_shift.clinic_id == 1 else "demo.front-b"], changed_at=end, reason="合成人工核实")
        if status in ("CANCELLED", "NO_SHOW"):
            canceled = status == "CANCELLED"
            changed_at = prior + timedelta(hours=5) if canceled else end
            DepositRefund.objects.create(
                deposit=paid, refund_amount=paid.amount if canceled else 0,
                reason="CLINIC_CANCELLATION" if canceled else "NO_SHOW",
                status="SUCCEEDED" if canceled else "RETAINED",
                idempotency_key=f"preview-fund-{number}", requested_at=changed_at,
                completed_at=changed_at if canceled else None,
            )
        if status in ("CHECKED_IN","IN_TREATMENT","COMPLETED"):
            audit = record_event(account_id=roles["demo.front-a" if active_shift.clinic_id == 1 else "demo.front-b"], action="APPOINTMENT_CHECKED_IN", target_type="appointment",
                                 target_id=row.pk, visible_fields=("claim_id","clinic_id","identity_confirmed"),
                                 after={"claim_id":str(claim.pk),"clinic_id":str(active_shift.clinic_id),"identity_confirmed":True})
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
    # Two closed dates, one week apart, keep the comparison reproducible on any demo day.
    preview_visits = {}
    for first_no, days_ago, actuals in ((100, 8, (6, 2)), (120, 1, (4, 3))):
        day = today - timedelta(days=days_ago)
        centre_shift = shift(day, 1, 1, 8, 12)
        branch_shift = shift(day, 2, 1, 14, 16)
        for clinic_index, (history_shift, hour, chair, size, actual) in enumerate((
            (centre_shift, 8, chairs[0], 8, actuals[0]),
            (branch_shift, 14, branch_chair, 4, actuals[1]),
        )):
            for index in range(size):
                attended = index < actual
                record = appointment(
                    first_no + clinic_index * 10 + index, history_shift,
                    at(day, hour + index // 2, index % 2 * 30), 1 if index == 0 else index + 2,
                    projects[1], "COMPLETED" if attended else "NO_SHOW", chair if attended else None,
                )
                if (first_no, clinic_index, index) in {(120, 0, 0), (120, 1, 1)}:
                    preview_visits[clinic_index] = Visit.objects.get(appointment=record)

    current_quarter = today.year * 4 + (today.month - 1) // 3
    for offset, stage in ((3, "confirmed"), (2, "confirmed"), (1, "review")):
        year, quarter_index = divmod(current_quarter - offset, 4)
        period = lock_period(year, quarter_index + 1)
        for idx, expense_name in enumerate(("设备维保", "诊室租赁", "院感耗材", "前台统筹")):
            clinic = 1 if idx % 2 == 0 else 2
            item = OperatingExpense.objects.create(
                clinic_id=clinic, period=period, expense_category=expense_name,
                amount=Decimal(18 + idx * 6), scope="SHARED",
            )
            proof = {"evidence_ref": f"ADC-DEMO-Q{year}-{quarter_index + 1}-{idx + 1}",
                     "clinic_id": str(clinic), "period_id": str(period.pk)}
            record_event(account_id=roles[f"demo.manager-{'a' if clinic == 1 else 'b'}"], action="EXPENSE_RECORDED",
                         target_type="operating_expense", target_id=item.pk, visible_fields=proof.keys(), after=proof)
        for index, day_of_month in enumerate((5, 12, 19)):
            day = today.replace(year=year, month=quarter_index * 3 + 1, day=day_of_month)
            for branch, chair, hour in ((1, chairs[0], 9), (2, branch_chair, 14)):
                work = shift(day, branch, 1, hour, hour + 2)
                for position in range(2):
                    number = 300 + 30 * offset + 6 * (branch - 1) + 2 * index + position
                    record = appointment(number, work, at(day, hour, 30 * position), 1 + number % 10,
                                         projects[(index + position + branch) % len(projects)], "COMPLETED", chair)
                    visit = Visit.objects.get(appointment=record)
                    preview_invoice(visit, "ISSUED")
        seed_performance_version(period, roles, stage)

    for i in range(4):
        future = today + timedelta(days=i + 8)
        branch = 1 if i % 2 == 0 else 2
        ShiftDemand.objects.create(clinic_id=branch, start_at=at(future, 9), end_at=at(future, 12), required_count=1 + i % 2)

    seed_treatment_bill(preview_visits[0], roles["demo.front-a"])
    seed_branch_refund(preview_visits[1])
    start, end = today-timedelta(days=8), today+timedelta(days=21)
    days = [(start+timedelta(days=off)).isoformat() for off in range((end-start).days+1)]
    calendar = {key:{"valid_from":start.isoformat(),"valid_to":end.isoformat(),
                     "version":"ADC-preview","working_dates":days} for key in ("1","2")}
    Path(settings.ADC_WORK_CALENDARS_PATH).write_text(json.dumps(calendar),encoding="utf-8")
    return {login:make_password("ADC-preview-2026") for login in roles}


def seed_performance_version(period, roles, stage):
    identifier = {"period_id": period.pk}
    planner = current_principal(roles["demo.calculate"], "staff")
    revision = calculate(planner, period.pk, OperationKey(planner.account_id, "performance_calculate", identifier, "preview-trial"))
    if stage == "confirmed":
        target = {**identifier, "revision_no": revision.revision_no}
        reviewer = current_principal(roles["demo.review"], "staff")
        review(reviewer, period.pk, revision.revision_no, {"decision": "APPROVED", "reason": "合成环境凭据核对通过"},
               OperationKey(reviewer.account_id, "performance_review", target, "preview-review"))
        approver = current_principal(roles["demo.confirm"], "staff")
        confirm(approver, period.pk, revision.revision_no,
                OperationKey(approver.account_id, "performance_confirm", target, "preview-confirm"))


def preview_invoice(visit, status):
    item = TreatmentItem.objects.select_related("treatment_type").get(visit=visit)
    invoice = Invoice.objects.create(
        invoice_no=visit.appointment.appointment_no.replace("ADC-DEMO-", "ADC-DEMO-INV-"),
        visit=visit, original_total=item.amount, status=status, issued_at=visit.ended_at + timedelta(minutes=1),
    )
    InvoiceLine.objects.create(invoice=invoice, treatment_item=item,
                               treatment_name_snapshot=item.treatment_type.treatment_name,
                               unit_name_snapshot=item.unit_name_snapshot, units=item.units,
                               unit_price=item.unit_price_snapshot, subtotal=item.amount)
    return invoice


def seed_treatment_bill(visit, clerk_id):
    invoice = preview_invoice(visit, "PART_PAID")
    issued = invoice.issued_at
    record_event(account_id=clerk_id, action="INVOICE_ISSUED", target_type="invoice", target_id=invoice.pk,
                 visible_fields=("visit_id", "original_total", "line_count"),
                 after={"visit_id": str(visit.pk), "original_total": "180.00", "line_count": 1})
    for suffix, amount, status, requested, receipt in (
        ("paid", Decimal("80.00"), "SUCCEEDED", issued + timedelta(seconds=30), issued + timedelta(minutes=1)),
        ("pending", Decimal("30.00"), "PENDING", issued + timedelta(hours=1), None),
    ):
        payment = InvoicePayment.objects.create(invoice=invoice, payment_kind="PAYMENT", amount=amount,
                                                 status=status, paid_at=receipt, idempotency_key="preview-tuition-" + suffix)
        event = record_event(account_id=clerk_id, action="INVOICE_PAYMENT_RECORDED", target_type="invoice_payment",
                             target_id=payment.pk, visible_fields=("invoice_id", "amount"),
                             after={"invoice_id": str(invoice.pk), "amount": str(amount)})
        type(event).objects.filter(pk=event.pk).update(occurred_at=requested)


def seed_branch_refund(visit):
    invoice = preview_invoice(visit, "SETTLED")
    issued = invoice.issued_at
    collection = InvoicePayment.objects.create(
        invoice=invoice, payment_kind="PAYMENT", amount=invoice.original_total, status="SUCCEEDED",
        paid_at=issued + timedelta(minutes=1), idempotency_key="preview-branch-received",
    )
    correction = TreatmentCorrection.objects.create(
        visit=visit, requested_by_id=visit.main_dentist_id, reason="合成费用更正", status="APPLIED",
        proposed_changes={"summary": "合成核对差额", "signed_amount": "-30.00"},
        requested_at=issued + timedelta(minutes=3),
    )
    CorrectionApproval.objects.create(
        correction=correction, reviewer_id=5, decision="APPROVED", reason="合成主管复核",
        decided_at=issued + timedelta(minutes=5),
    )
    adjustment = InvoiceAdjustment.objects.create(
        invoice=invoice, correction=correction, signed_amount="-30.00", created_at=issued + timedelta(minutes=6),
    )
    InvoicePayment.objects.create(
        invoice=invoice, payment_kind="REFUND", amount="20.00", status="SUCCEEDED", source_payment=collection,
        adjustment=adjustment, paid_at=issued + timedelta(minutes=8), idempotency_key="preview-branch-refund",
    )


with transaction.atomic():
    if Clinic.objects.exists():
        raise RuntimeError("The preview database already contains records.")
    load_synthetic_base()
    hashes = seed()
print(json.dumps(hashes))
