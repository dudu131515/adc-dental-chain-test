from django.db import models
from django.utils import timezone


class Employee(models.Model):
    class Job(models.TextChoices):
        HEADQUARTERS = "HEADQUARTERS", "总部管理人员"
        CLINIC_MANAGER = "CLINIC_MANAGER", "诊所主管"
        FRONT_DESK = "FRONT_DESK", "前台"
        DENTIST = "DENTIST", "牙医"

    employee_id = models.BigAutoField(primary_key=True)
    employee_no = models.CharField(max_length=40, unique=True)
    full_name = models.CharField(max_length=100)
    birth_date = models.DateField(null=True)
    home_address = models.TextField(null=True)
    phone = models.CharField(max_length=40, null=True)
    email = models.CharField(max_length=120, null=True)
    status = models.CharField(max_length=20, default="ACTIVE")
    job_code = models.CharField(max_length=20, choices=Job.choices, null=True)
    home_clinic = models.ForeignKey("Clinic", on_delete=models.PROTECT, related_name="home_employees", null=True)

    class Meta:
        db_table = "employee"
        managed = False


class Clinic(models.Model):
    clinic_id = models.BigAutoField(primary_key=True)
    clinic_no = models.CharField(max_length=40, unique=True)
    clinic_name = models.CharField(max_length=150)
    postal_address = models.TextField()
    manager = models.ForeignKey(Employee, on_delete=models.PROTECT, null=True)
    phone = models.CharField(max_length=40, null=True)
    email = models.CharField(max_length=120, null=True)
    area_sqm = models.DecimalField(max_digits=10, decimal_places=2, null=True)
    status = models.CharField(max_length=20, default="ACTIVE")

    class Meta:
        db_table = "clinic"
        managed = False


class AppRole(models.Model):
    role_id = models.BigAutoField(primary_key=True)
    role_code = models.CharField(max_length=50, unique=True)
    role_name = models.CharField(max_length=80)

    class Meta:
        db_table = "app_role"
        managed = False


class EmployeeRole(models.Model):
    id = models.BigAutoField(primary_key=True)
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT)
    role = models.ForeignKey(AppRole, on_delete=models.PROTECT)
    scope_clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT, null=True)

    class Meta:
        db_table = "employee_role"
        managed = False


class Patient(models.Model):
    patient_id = models.BigAutoField(primary_key=True)
    patient_no = models.CharField(max_length=40, unique=True)
    full_name = models.CharField(max_length=100)
    birth_date = models.DateField()
    billing_address = models.TextField()
    phone = models.CharField(max_length=40)
    email = models.CharField(max_length=120, null=True)
    emergency_name = models.CharField(max_length=100)
    emergency_phone = models.CharField(max_length=40)

    class Meta:
        db_table = "patient"
        managed = False


class UserAccount(models.Model):
    id = models.BigAutoField(primary_key=True)
    patient = models.OneToOneField(Patient, on_delete=models.PROTECT, null=True)
    employee = models.OneToOneField(Employee, on_delete=models.PROTECT, null=True)
    login_identity = models.CharField(max_length=180, unique=True)
    status = models.CharField(max_length=20, default="ACTIVE")

    class Meta:
        db_table = "user_account"
        managed = False


class AuditLog(models.Model):
    id = models.BigAutoField(primary_key=True)
    account = models.ForeignKey(UserAccount, on_delete=models.PROTECT, null=True)
    action = models.CharField(max_length=80)
    target_type = models.CharField(max_length=80)
    target_id = models.BigIntegerField(null=True)
    before_value = models.JSONField(null=True)
    after_value = models.JSONField(null=True)
    occurred_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "audit_log"
        managed = False
