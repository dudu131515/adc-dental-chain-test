from django.db import models
from django.utils import timezone

from adc.booking.models import Appointment
from adc.catalog.models import TreatmentType
from adc.identity.models import Employee, Patient
from adc.scheduling.models import DentalChair


class PatientAllergy(models.Model):
    id = models.BigAutoField(primary_key=True)
    patient = models.ForeignKey(Patient, on_delete=models.PROTECT)
    allergen_name = models.CharField(max_length=120)
    notes = models.TextField(null=True)

    class Meta:
        managed = False
        db_table = "patient_allergy"


class Visit(models.Model):
    visit_id = models.BigAutoField(primary_key=True)
    appointment = models.OneToOneField(Appointment, on_delete=models.PROTECT)
    main_dentist = models.ForeignKey(Employee, on_delete=models.PROTECT)
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True)
    status = models.CharField(max_length=20)
    clinical_notes = models.TextField(null=True)
    termination_reason = models.TextField(null=True)

    class Meta:
        managed = False
        db_table = "visit"


class ChairUsage(models.Model):
    id = models.BigAutoField(primary_key=True)
    appointment = models.ForeignKey(Appointment, on_delete=models.PROTECT)
    chair = models.ForeignKey(DentalChair, on_delete=models.PROTECT)
    assigned_at = models.DateTimeField(default=timezone.now)
    released_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = "chair_usage"


class DentistWorkSession(models.Model):
    id = models.BigAutoField(primary_key=True)
    visit = models.ForeignKey(Visit, on_delete=models.PROTECT)
    dentist = models.ForeignKey(Employee, on_delete=models.PROTECT)
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField()
    duration_minutes = models.DecimalField(max_digits=12, decimal_places=2)

    class Meta:
        managed = False
        db_table = "dentist_work_session"


class TreatmentItem(models.Model):
    item_id = models.BigAutoField(primary_key=True)
    visit = models.ForeignKey(Visit, on_delete=models.PROTECT)
    treatment_type = models.ForeignKey(TreatmentType, on_delete=models.PROTECT)
    performing_dentist = models.ForeignKey(Employee, on_delete=models.PROTECT)
    tooth_code = models.CharField(max_length=20, null=True)
    units = models.DecimalField(max_digits=12, decimal_places=3)
    unit_name_snapshot = models.CharField(max_length=50)
    unit_price_snapshot = models.DecimalField(max_digits=12, decimal_places=2)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    patient_consented = models.BooleanField(default=False)
    is_additional = models.BooleanField(default=False)
    recorded_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "treatment_item"


class Material(models.Model):
    material_id = models.BigAutoField(primary_key=True)
    material_code = models.CharField(max_length=40, unique=True)
    material_name = models.CharField(max_length=140)
    standard_unit = models.CharField(max_length=50)
    status = models.CharField(max_length=20, default="ACTIVE")

    class Meta:
        managed = False
        db_table = "material"


class MaterialCost(models.Model):
    id = models.BigAutoField(primary_key=True)
    material = models.ForeignKey(Material, on_delete=models.PROTECT)
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2)
    effective_from = models.DateField()
    effective_to = models.DateField(null=True)

    class Meta:
        managed = False
        db_table = "material_cost"


class MaterialUsage(models.Model):
    id = models.BigAutoField(primary_key=True)
    treatment_item = models.ForeignKey(TreatmentItem, on_delete=models.PROTECT)
    material = models.ForeignKey(Material, on_delete=models.PROTECT)
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    unit_cost_snapshot = models.DecimalField(max_digits=12, decimal_places=2)
    material_name_snapshot = models.CharField(max_length=140, null=True)
    unit_name_snapshot = models.CharField(max_length=50, null=True)

    class Meta:
        managed = False
        db_table = "material_usage"
