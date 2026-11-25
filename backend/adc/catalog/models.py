from django.db import models

from adc.scheduling.models import Qualification


class TreatmentType(models.Model):
    treatment_type_id = models.BigAutoField(primary_key=True)
    treatment_code = models.CharField(max_length=50, unique=True)
    treatment_name = models.CharField(max_length=160)
    standard_unit = models.CharField(max_length=50)
    required_qualification = models.ForeignKey(Qualification, on_delete=models.PROTECT, null=True)
    active = models.BooleanField(default=True)
    default_slot_minutes = models.IntegerField(null=True)
    required_chair_kind = models.CharField(max_length=40, null=True)

    class Meta:
        db_table = "treatment_type"
        managed = False


class TreatmentPrice(models.Model):
    id = models.BigAutoField(primary_key=True)
    treatment_type = models.ForeignKey(TreatmentType, on_delete=models.PROTECT)
    unit_price = models.DecimalField(max_digits=12, decimal_places=2)
    effective_from = models.DateField()
    effective_to = models.DateField(null=True)

    class Meta:
        db_table = "treatment_price"
        managed = False
