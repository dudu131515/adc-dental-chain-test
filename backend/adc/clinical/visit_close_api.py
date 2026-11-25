from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.clinical.visit_api import own_visit, visit_projection
from adc.clinical.visit_close import close_visit
from adc.common.http import success
from adc.common.idempotency import OperationKey
from adc.common.serializers import values


class Finish(serializers.Serializer):
    clinical_notes = serializers.CharField(required=False, allow_blank=True)


class Terminate(Finish):
    reason = serializers.CharField()


def close(request, pk, *, terminated):
    original = own_visit(request, pk)
    fields = values(Terminate if terminated else Finish, request.data)
    operation = OperationKey.from_request(
        request, command="terminate_visit" if terminated else "finish_visit", target={"visit_id": pk},
    )
    entry = close_visit(request.user, original, fields, operation, terminated=terminated)
    return success(visit_projection(entry, clinical=True))


@api_view(["POST"])
def finish(request, pk):
    return close(request, pk, terminated=False)


@api_view(["POST"])
def terminate(request, pk):
    return close(request, pk, terminated=True)


urlpatterns = [
    path("visits/<int:pk>/finish", finish),
    path("visits/<int:pk>/terminate", terminate),
]
