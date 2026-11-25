from django.db import transaction
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.common.http import success
from adc.common.idempotency import OperationKey
from adc.common.serializers import values
from adc.reporting.models import PerformancePeriod
from adc.reporting.period_locks import lock_period
from adc.reporting.permissions import CALCULATE, PERFORMANCE_ROLES, WORK_ROLES, includes_company, require_company, visible_scope
from adc.reporting.quarter_versions import calculate, latest_confirmed, projection, revisions_for


class PeriodInput(serializers.Serializer):
    year = serializers.IntegerField(min_value=2020, max_value=9998)
    quarter = serializers.IntegerField(min_value=1, max_value=4)


def identifiers(period):
    return {"period_id": str(period.pk), "year": period.perf_year, "quarter": period.perf_quarter}


def summary(period, workspace):
    latest = latest_confirmed(period.pk)
    return {
        **identifiers(period), "status": period.status if workspace or latest else "OPEN",
        "latest_confirmed_revision_no": latest.revision_no if latest else None,
    }


@api_view(["GET", "POST"])
def periods(request):
    if request.method == "POST":
        require_company(request.user, CALCULATE)
        fields = values(PeriodInput, request.data)
        with transaction.atomic():
            period = lock_period(fields["year"], fields["quarter"])
        return success(summary(period, True))
    visible_scope(request.user, "CLINIC_MANAGER", *PERFORMANCE_ROLES)
    allowed = any(request.user.allows(role) for role in PERFORMANCE_ROLES)
    workspace = any(request.user.allows(role) for role in WORK_ROLES)
    rows = PerformancePeriod.objects.order_by("-perf_year", "-perf_quarter")
    if allowed and not workspace:
        rows = rows.filter(status="CONFIRMED")
    return success({"items": [summary(period, workspace) if allowed else identifiers(period) for period in rows], "next_cursor": None})


@api_view(["GET"])
def period_detail(request, pk):
    visible_scope(request.user, *PERFORMANCE_ROLES)
    workspace = any(request.user.allows(role) for role in WORK_ROLES)
    query = PerformancePeriod.objects.all() if workspace else PerformancePeriod.objects.filter(status="CONFIRMED")
    period = get_object_or_404(query, pk=pk)
    latest = latest_confirmed(period.pk)
    current = revisions_for(period.pk, True).filter(confirmed_at__isnull=True).first() if workspace else None
    may_calculate = request.user.allows(CALCULATE) and includes_company(request.user.clinic_scope(CALCULATE))
    return success({
        **summary(period, workspace), "latest_confirmed": projection(latest, request.user) if latest else None,
        "workspace": projection(current, request.user) if current else None,
        "allowed_actions": ["calculate"] if may_calculate and (current or not latest) else [],
    })


@api_view(["POST"])
def run_calculation(request, pk):
    require_company(request.user, CALCULATE)
    operation = OperationKey.from_request(request, command="performance_calculate", target={"period_id": pk})
    revision = calculate(request.user, pk, operation)
    return success(projection(revision, request.user))


urlpatterns = [
    path("performance/periods", periods),
    path("performance/periods/<int:pk>", period_detail),
    path("performance/periods/<int:pk>/calculate", run_calculation),
]
