from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.common.http import success
from adc.common.idempotency import OperationKey
from adc.common.serializers import values
from adc.reporting.models import PerformancePeriod
from adc.reporting.permissions import CONFIRM, PERFORMANCE_ROLES, REVIEW, WORK_ROLES, require_company, visible_scope
from adc.reporting.quarter_versions import confirm, projection, review, revisions_for


class ReviewInput(serializers.Serializer):
    decision = serializers.ChoiceField(choices=("APPROVED", "REJECTED"))
    reason = serializers.CharField(max_length=1000)


def visible_revisions(principal, pk):
    visible_scope(principal, *PERFORMANCE_ROLES)
    workspace = any(principal.allows(role) for role in WORK_ROLES)
    period = PerformancePeriod.objects.all() if workspace else PerformancePeriod.objects.filter(status="CONFIRMED")
    get_object_or_404(period, pk=pk)
    return revisions_for(pk, workspace)


@api_view(["GET"])
def revisions(request, pk):
    rows = visible_revisions(request.user, pk)
    return success({"items": [projection(row, request.user) for row in rows], "next_cursor": None})


@api_view(["GET"])
def revision(request, pk, revision_no):
    row = get_object_or_404(visible_revisions(request.user, pk), revision_no=revision_no)
    return success(projection(row, request.user))


@api_view(["POST"])
def review_revision(request, pk, revision_no):
    require_company(request.user, REVIEW)
    fields = values(ReviewInput, request.data)
    operation = OperationKey.from_request(
        request, command="performance_review", target={"period_id": pk, "revision_no": revision_no},
    )
    return success(projection(review(request.user, pk, revision_no, fields, operation), request.user))


@api_view(["POST"])
def confirm_revision(request, pk, revision_no):
    require_company(request.user, CONFIRM)
    operation = OperationKey.from_request(
        request, command="performance_confirm", target={"period_id": pk, "revision_no": revision_no},
    )
    return success(projection(confirm(request.user, pk, revision_no, operation), request.user))


urlpatterns = [
    path("performance/periods/<int:pk>/revisions", revisions),
    path("performance/periods/<int:pk>/revisions/<int:revision_no>", revision),
    path("performance/periods/<int:pk>/revisions/<int:revision_no>/review", review_revision),
    path("performance/periods/<int:pk>/revisions/<int:revision_no>/confirm", confirm_revision),
]
