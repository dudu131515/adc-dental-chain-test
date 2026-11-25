from django.db import models
from django.utils import timezone

from adc.clinical.models import TreatmentItem, Visit
from adc.identity.models import Employee


class Invoice(models.Model):
    invoice_id = models.BigAutoField(primary_key=True)
    invoice_no = models.CharField(max_length=50, unique=True)
    visit = models.OneToOneField(Visit, on_delete=models.PROTECT)
    original_total = models.DecimalField(max_digits=14, decimal_places=2)
    status = models.CharField(max_length=24)
    issued_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "invoice"


class InvoiceLine(models.Model):
    line_id = models.BigAutoField(primary_key=True)
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT)
    treatment_item = models.OneToOneField(TreatmentItem, on_delete=models.PROTECT)
    treatment_name_snapshot = models.CharField(max_length=160)
    unit_name_snapshot = models.CharField(max_length=50)
    units = models.DecimalField(max_digits=12, decimal_places=3)
    unit_price = models.DecimalField(max_digits=12, decimal_places=2)
    subtotal = models.DecimalField(max_digits=14, decimal_places=2)

    class Meta:
        managed = False
        db_table = "invoice_line"


class TreatmentCorrection(models.Model):
    id = models.BigAutoField(primary_key=True)
    visit = models.ForeignKey(Visit, on_delete=models.PROTECT)
    requested_by = models.ForeignKey(Employee, db_column="requested_by", on_delete=models.PROTECT)
    reason = models.TextField()
    proposed_changes = models.JSONField()
    status = models.CharField(max_length=20)
    requested_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "treatment_correction"


class CorrectionApproval(models.Model):
    id = models.BigAutoField(primary_key=True)
    correction = models.OneToOneField(TreatmentCorrection, on_delete=models.PROTECT)
    reviewer = models.ForeignKey(Employee, on_delete=models.PROTECT)
    decision = models.CharField(max_length=15)
    reason = models.TextField(null=True)
    decided_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "correction_approval"


class InvoiceAdjustment(models.Model):
    id = models.BigAutoField(primary_key=True)
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT)
    correction = models.OneToOneField(TreatmentCorrection, on_delete=models.PROTECT)
    signed_amount = models.DecimalField(max_digits=14, decimal_places=2)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "invoice_adjustment"


class InvoicePayment(models.Model):
    payment_id = models.BigAutoField(primary_key=True)
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT)
    payment_kind = models.CharField(max_length=12)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    status = models.CharField(max_length=20)
    paid_at = models.DateTimeField(null=True)
    idempotency_key = models.CharField(max_length=100, unique=True)
    adjustment = models.ForeignKey(InvoiceAdjustment, on_delete=models.PROTECT, null=True)
    source_payment = models.ForeignKey("self", on_delete=models.PROTECT, null=True, related_name="refunds")

    class Meta:
        managed = False
        db_table = "invoice_payment"
