from decimal import Decimal

from django.db import models
from django.utils import timezone

from adc.catalog.models import TreatmentType
from adc.identity.models import Clinic, Employee, Patient
from adc.scheduling.models import Shift


class SlotClaim(models.Model):
    claim_id = models.BigAutoField(primary_key=True)
    patient = models.ForeignKey(Patient, on_delete=models.PROTECT)
    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT)
    dentist = models.ForeignKey(Employee, on_delete=models.PROTECT)
    shift = models.ForeignKey(Shift, on_delete=models.PROTECT)
    requested_treatment_type = models.ForeignKey(TreatmentType, on_delete=models.PROTECT)
    required_chair_kind = models.CharField(max_length=40, null=True)
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    expires_at = models.DateTimeField(null=True)
    status = models.CharField(max_length=20)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "slot_claim"


class DepositPayment(models.Model):
    deposit_id = models.BigAutoField(primary_key=True)
    claim = models.OneToOneField(SlotClaim, on_delete=models.PROTECT)
    amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("50.00"))
    status = models.CharField(max_length=30)
    payment_token = models.CharField(max_length=100, unique=True, null=True)
    paid_at = models.DateTimeField(null=True)

    @property
    def client_status(self):
        if self.status == "PENDING" and not self.payment_token:
            return "NOT_STARTED"
        return self.status

    class Meta:
        managed = False
        db_table = "deposit_payment"


class Appointment(models.Model):
    appointment_id = models.BigAutoField(primary_key=True)
    appointment_no = models.CharField(max_length=50, unique=True)
    claim = models.OneToOneField(SlotClaim, on_delete=models.PROTECT)
    deposit = models.OneToOneField(DepositPayment, on_delete=models.PROTECT)
    status = models.CharField(max_length=20)
    is_attended = models.BooleanField(default=False)
    planned_treatment_note = models.TextField(null=True)
    special_requirement = models.TextField(null=True)
    confirmed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "appointment"


class AppointmentChange(models.Model):
    id = models.BigAutoField(primary_key=True)
    appointment = models.ForeignKey(Appointment, on_delete=models.PROTECT)
    change_type = models.CharField(max_length=30)
    cancel_party = models.CharField(max_length=16, null=True)
    old_claim = models.ForeignKey(SlotClaim, on_delete=models.PROTECT, null=True, related_name="+")
    new_claim = models.ForeignKey(SlotClaim, on_delete=models.PROTECT, null=True, related_name="+")
    reason = models.TextField(null=True)
    changed_by = models.ForeignKey(Employee, on_delete=models.PROTECT, db_column="changed_by", null=True)
    changed_by_patient = models.ForeignKey(Patient, on_delete=models.PROTECT, null=True)
    changed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "appointment_change"


class DepositRefund(models.Model):
    refund_id = models.BigAutoField(primary_key=True)
    deposit = models.ForeignKey(DepositPayment, on_delete=models.PROTECT)
    refund_amount = models.DecimalField(max_digits=12, decimal_places=2)
    reason = models.CharField(max_length=60)
    status = models.CharField(max_length=30)
    idempotency_key = models.CharField(max_length=100, unique=True)
    requested_at = models.DateTimeField(default=timezone.now)
    completed_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = "deposit_refund"


class AppointmentRequestedTreatment(models.Model):
    id = models.BigAutoField(primary_key=True)
    appointment = models.ForeignKey(Appointment, on_delete=models.PROTECT)
    treatment_type = models.ForeignKey(TreatmentType, on_delete=models.PROTECT)
    notes = models.TextField(null=True)

    class Meta:
        managed = False
        db_table = "appointment_requested_treatment"
