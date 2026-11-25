from django.db import models
from django.utils import timezone

from adc.identity.models import Clinic, Employee
from adc.reporting.models.periods import PerformancePeriod


class OperatingExpense(models.Model):
    expense_id = models.BigAutoField(primary_key=True)
    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT)
    period = models.ForeignKey(PerformancePeriod, on_delete=models.PROTECT)
    expense_category = models.CharField(max_length=100)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    scope = models.CharField(max_length=20)
    dentist = models.ForeignKey(Employee, on_delete=models.PROTECT, null=True)

    class Meta:
        managed = False
        db_table = "operating_expense"


class ExpenseAllocation(models.Model):
    expense = models.ForeignKey(OperatingExpense, on_delete=models.PROTECT)
    dentist = models.ForeignKey(Employee, on_delete=models.PROTECT)
    allocated_amount = models.DecimalField(max_digits=14, decimal_places=2)
    basis_minutes = models.DecimalField(max_digits=12, decimal_places=2, null=True)

    class Meta:
        managed = False
        db_table = "expense_allocation"


class DentistPerformance(models.Model):
    # PostgreSQL enforces (period_id, revision_no) against the identified revision.
    period = models.ForeignKey(PerformancePeriod, on_delete=models.PROTECT)
    revision_no = models.IntegerField(default=1)
    dentist = models.ForeignKey(Employee, on_delete=models.PROTECT)
    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT)
    revenue = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    material_cost = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    operating_cost = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    net_profit = models.DecimalField(max_digits=14, decimal_places=2, default=0)

    class Meta:
        managed = False
        db_table = "dentist_performance"


class CompanyPerformance(models.Model):
    period = models.ForeignKey(PerformancePeriod, on_delete=models.PROTECT)
    revision_no = models.IntegerField(default=1)
    revenue = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    material_cost = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    operating_cost = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    net_profit = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    incentive_fund = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    calculated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        managed = False
        db_table = "company_performance"
