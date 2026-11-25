from django.db import models

from adc.identity.models import Employee


class PerformancePeriod(models.Model):
    period_id = models.BigAutoField(primary_key=True)
    perf_year = models.IntegerField()
    perf_quarter = models.IntegerField()
    status = models.CharField(max_length=20)

    class Meta:
        managed = False
        db_table = "performance_period"


class PerformanceRevision(models.Model):
    revision_id = models.BigAutoField(primary_key=True)
    period = models.ForeignKey(PerformancePeriod, on_delete=models.PROTECT)
    revision_no = models.IntegerField()
    source_adjustment = models.OneToOneField(
        "billing.InvoiceAdjustment", on_delete=models.PROTECT, null=True,
    )
    confirmed_by = models.ForeignKey(Employee, db_column="confirmed_by", on_delete=models.PROTECT, null=True)
    confirmed_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = "performance_revision"
