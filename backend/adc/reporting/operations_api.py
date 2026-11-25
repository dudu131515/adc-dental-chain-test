from datetime import date

from django.urls import path
from django.utils.timezone import now
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.common.http import success
from adc.common.serializers import ID, values
from adc.reporting.fact_queries import consistent_read
from adc.reporting.operations_service import report
from adc.reporting.permissions import QUERY
from adc.reporting.snapshots import read_details, store_snapshot


class ReportQuery(serializers.Serializer):
    date_from = serializers.DateField()
    date_to = serializers.DateField()
    clinic_ids = serializers.ListField(child=ID(), required=False)
    dentist_ids = serializers.ListField(child=ID(), required=False)

    def validate(self, data):
        if data["date_to"] < data["date_from"] or data["date_to"] == date.max:
            raise serializers.ValidationError({"date_to": "请选择有效的统计结束日期。"})
        return data


class DetailQuery(serializers.Serializer):
    report_token = serializers.RegexField(r"^[A-Za-z0-9_-]{32}$")
    metric = serializers.CharField(max_length=40)
    clinic_id = ID(required=False)
    cursor = serializers.CharField(max_length=4096, required=False)


def query_parameters(query):
    fields = {key: query[key] for key in ("date_from", "date_to") if key in query}
    for key in ("clinic_ids", "dentist_ids"):
        fields[key] = [value for group in query.getlist(key) for value in group.split(",")] if key in query else []
    return fields


@api_view(["GET"])
def operations(request):
    cutoff = now()
    request.user.require(QUERY)
    fields = values(ReportQuery, query_parameters(request.query_params))
    with consistent_read():
        metadata, results, details = report(request.user, fields, cutoff)
    token = store_snapshot(request.user, metadata, details)
    return success({**metadata, **results, "report_token": token})


@api_view(["GET"])
def operation_details(request):
    request.user.require(QUERY)
    fields = values(DetailQuery, request.query_params)
    clinic = str(fields["clinic_id"]) if "clinic_id" in fields else None
    return success(read_details(request.user, fields["report_token"], fields["metric"], clinic, fields.get("cursor")))


urlpatterns = [
    path("reports/operations", operations),
    path("reports/operations/details", operation_details),
]
