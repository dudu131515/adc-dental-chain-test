from collections.abc import Mapping

from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.common.http import success
from adc.common.idempotency import OperationKey
from adc.common.serializers import values
from adc.reporting import assistant_service
from adc.reporting.assistant_intent import METRICS
from adc.reporting.operations_api import ReportQuery, query_parameters
from adc.reporting.permissions import QUERY


class AnalysisQuery(ReportQuery):
    metric = serializers.ChoiceField(
        choices=tuple(METRICS), required=False, error_messages={"invalid_choice": "请选择可用的经营指标。"},
    )
    question = serializers.CharField(required=False, max_length=160)
    comparison_date_from = serializers.DateField(required=False)
    comparison_date_to = serializers.DateField(required=False)

    def to_internal_value(self, data):
        if isinstance(data, Mapping) and data.keys() - self.fields.keys():
            raise serializers.ValidationError({"non_field_errors": ["请求只接受经营指标、统计期间和授权范围等分析选项。"]})
        return super().to_internal_value(data)

    def validate(self, data):
        data = super().validate(data)
        if ("metric" in data) == ("question" in data):
            raise serializers.ValidationError("请选择一项指标或输入一个经营问题。")
        if ("comparison_date_from" in data) != ("comparison_date_to" in data):
            raise serializers.ValidationError("请完整选择对比期间的起止日期。")
        return data


class AnalysisLookup(serializers.Serializer):
    analysis_id = serializers.RegexField(r"^[A-Za-z0-9_-]{32}$")


class ReportLookup(serializers.Serializer):
    reference = serializers.RegexField(r"^[A-Za-z0-9_:-]+$", max_length=4096)


@api_view(["GET"])
def suggestions(request):
    request.user.require(QUERY)
    fields = values(ReportQuery, query_parameters(request.query_params))
    return success(assistant_service.suggestions(request.user, fields))


@api_view(["GET", "POST"])
def analysis(request):
    request.user.require(QUERY)
    if request.method == "GET":
        fields = values(AnalysisLookup, request.query_params)
        return success(assistant_service.result_for(request.user, fields["analysis_id"]))
    fields = values(AnalysisQuery, request.data)
    operation = OperationKey.from_request(request, command="operations_assistant", target={})
    return success(assistant_service.analyze(request.user, fields, operation))


@api_view(["GET"])
def analysis_by_action(request):
    request.user.require(QUERY)
    operation = OperationKey.from_request(request, command="operations_assistant", target={})
    return success(assistant_service.recover_analysis(request.user, operation))


@api_view(["GET"])
def original_report(request):
    request.user.require(QUERY)
    fields = values(ReportLookup, request.query_params)
    return success(assistant_service.original_report(request.user, fields["reference"]))


urlpatterns = [
    path("suggestions", suggestions),
    path("analysis", analysis),
    path("analysis/by-action", analysis_by_action),
    path("report", original_report),
]
