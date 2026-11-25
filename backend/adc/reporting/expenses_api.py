from decimal import Decimal

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.billing.invoice_service import amount_data
from adc.clinical.models import Visit
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Clinic, EmployeeRole
from adc.reporting.models import OperatingExpense, PerformancePeriod
from adc.reporting.permissions import PERFORMANCE_ROLES, filter_clinics, visible_scope


class ExpenseInput(serializers.Serializer):
    clinic_id = ID()
    period_id = ID()
    expense_category = serializers.CharField(max_length=100)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=Decimal("0"))
    scope = serializers.ChoiceField(choices=("DIRECT", "SHARED"))
    dentist_id = ID(required=False, allow_null=True, default=None)
    evidence_ref = serializers.CharField(max_length=180)

    def validate(self, data):
        if (data["scope"] == "DIRECT") != (data["dentist_id"] is not None):
            raise serializers.ValidationError({"dentist_id": "直接费用必须选择归属牙医，共同费用无需选择。"})
        return data


class ExpenseQuery(serializers.Serializer):
    clinic_id = ID(required=False)
    period_id = ID(required=False)


def expense_evidence(ids):
    result = {}
    events = AuditLog.objects.filter(
        action="EXPENSE_RECORDED", target_type="operating_expense", target_id__in=ids,
    ).order_by("pk")
    for entry in events:
        result[entry.target_id] = entry.after_value
    return result


def projection(row, evidence):
    return {
        "expense_id": str(row.pk), "clinic_id": str(row.clinic_id), "period_id": str(row.period_id),
        "expense_category": row.expense_category, "amount": amount_data(row.amount),
        "scope": row.scope, "dentist_id": str(row.dentist_id) if row.dentist_id else None,
        "evidence_ref": evidence.get("evidence_ref"),
    }


def dentist_at_clinic(dentist_id, clinic_id):
    return (
        EmployeeRole.objects.filter(
            employee_id=dentist_id, role__role_code="DENTIST", scope_clinic_id=clinic_id,
        ).exists()
        or Visit.objects.filter(main_dentist_id=dentist_id, appointment__claim__clinic_id=clinic_id).exists()
    )


def record_expense(request):
    fields = values(ExpenseInput, request.data)
    clinic_id = fields["clinic_id"]
    request.user.require("CLINIC_MANAGER", clinic_id)
    operation = OperationKey.from_request(
        request, command="operating_expense", target={"period_id": fields["period_id"], "clinic_id": clinic_id},
    )
    with transaction.atomic():
        period = get_object_or_404(PerformancePeriod.objects.select_for_update(), pk=fields["period_id"])
        prior = operation.result_id(fields)
        if prior:
            return success(projection(OperatingExpense.objects.get(pk=prior), expense_evidence([prior])[prior]))
        if period.status == "CONFIRMED":
            raise ApiProblem(409, "INVALID_TRANSITION", "该季度已确认，已确认的费用证据不能再登记。")
        get_object_or_404(Clinic, pk=clinic_id)
        if fields["dentist_id"] and not dentist_at_clinic(fields["dentist_id"], clinic_id):
            raise ApiProblem(400, "VALIDATION_ERROR", "直接费用的牙医缺少本店归属依据。")
        row = OperatingExpense.objects.create(**{key: val for key, val in fields.items() if key != "evidence_ref"})
        proof = {"evidence_ref": fields["evidence_ref"], "clinic_id": str(clinic_id), "period_id": str(period.pk)}
        record_event(
            account_id=request.user.account_id, action="EXPENSE_RECORDED", target_type="operating_expense",
            target_id=row.pk, visible_fields=proof.keys(), after=proof,
        )
        operation.record_result(row.pk, fields)
    return success(projection(row, proof), status_code=201)


@api_view(["GET", "POST"])
def expenses(request):
    if request.method == "POST":
        return record_expense(request)
    scope = visible_scope(request.user, "CLINIC_MANAGER", *PERFORMANCE_ROLES)
    filters = values(ExpenseQuery, request.query_params)
    if "clinic_id" in filters and scope is not None and filters["clinic_id"] not in scope:
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能查看该门店费用。")
    rows = list(filter_clinics(OperatingExpense.objects.filter(**filters), scope).order_by("-pk"))
    proof = expense_evidence([row.pk for row in rows])
    return success({"items": [projection(row, proof.get(row.pk, {})) for row in rows], "next_cursor": None})


urlpatterns = [path("expenses", expenses)]
