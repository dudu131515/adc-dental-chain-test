from django.db import models

from adc.identity.models import Clinic, Employee


class Qualification(models.Model):
    qualification_id = models.BigAutoField(primary_key=True)
    qualification_code = models.CharField(max_length=50, unique=True)
    qualification_name = models.CharField(max_length=120)

    class Meta:
        managed = False
        db_table = "qualification"


class EmployeeQualification(models.Model):
    id = models.BigAutoField(primary_key=True)
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT)
    qualification = models.ForeignKey(Qualification, on_delete=models.PROTECT)
    certificate_no = models.CharField(max_length=80, null=True)
    valid_from = models.DateField(null=True)
    valid_until = models.DateField(null=True)

    class Meta:
        managed = False
        db_table = "employee_qualification"


class ShiftDemand(models.Model):
    demand_id = models.BigAutoField(primary_key=True)
    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT)
    required_qualification = models.ForeignKey(Qualification, on_delete=models.PROTECT, null=True)
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    required_count = models.IntegerField(default=1)
    status = models.CharField(max_length=20, default="SUBMITTED")

    class Meta:
        managed = False
        db_table = "shift_demand"


class Shift(models.Model):
    shift_id = models.BigAutoField(primary_key=True)
    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT)
    dentist = models.ForeignKey(Employee, on_delete=models.PROTECT)
    demand = models.ForeignKey(ShiftDemand, on_delete=models.PROTECT, null=True)
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    status = models.CharField(max_length=20)
    doctor_response_at = models.DateTimeField(null=True)
    published_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = "shift"


class DentalChair(models.Model):
    chair_id = models.BigAutoField(primary_key=True)
    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT)
    chair_no = models.CharField(max_length=40)
    status = models.CharField(max_length=20, default="AVAILABLE")
    chair_kind = models.CharField(max_length=40, default="GENERAL")

    class Meta:
        managed = False
        db_table = "dental_chair"


class DentalChairUnavailability(models.Model):
    id = models.BigAutoField(primary_key=True)
    chair = models.ForeignKey(DentalChair, on_delete=models.PROTECT)
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    reason = models.TextField()

    class Meta:
        managed = False
        db_table = "dental_chair_unavailability"
