from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.billing.correction_service import apply_correction, approval_evidence, new_correction, review_correction
from adc.billing.invoice_service import amount_data
from adc.billing.models import CorrectionApproval, Invoice, TreatmentCorrection
from adc.clinical.visit_api import own_visit
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values


class ProposedChanges(serializers.Serializer):
    signed_amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    summary = serializers.CharField()


class EditRequest(serializers.Serializer):
    invoice_id = ID()
    reason = serializers.CharField()
    proposed_changes = ProposedChanges()


class Approve(serializers.Serializer):
    decision = serializers.ChoiceField(choices=("APPROVED", "REJECTED"))
    reason = serializers.CharField()
    approved_signed_amount = serializers.DecimalField(max_digits=14, decimal_places=2, required=False)


class Apply(serializers.Serializer):
    invoice_id = ID()


def accessible_corrections(principal):
    if not any(principal.allows(role) for role in ("FRONT_DESK", "DENTIST", "CLINIC_MANAGER")):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能访问诊疗更正。")
    valid = Q(visit__appointment__claim__clinic_id__in=principal.clinic_scope("FRONT_DESK", "CLINIC_MANAGER"))
    if principal.allows("DENTIST"):
        valid |= Q(visit__main_dentist_id=principal.employee_id, visit__appointment__claim__clinic_id__in=principal.clinic_scope("DENTIST"))
    return TreatmentCorrection.objects.select_related("visit__appointment__claim").filter(valid)


def correction_data(row, principal):
    visit = row.visit
    invoice_id = Invoice.objects.get(visit=visit).pk
    response = {
        "correction_id": str(row.pk), "visit_id": str(visit.pk),
        "clinic_id": str(visit.appointment.claim.clinic_id),
        "invoice_id": str(invoice_id), "status": row.status,
        "requested_at": row.requested_at.isoformat(), "proposed_amount": row.proposed_changes["signed_amount"],
    }
    if principal.allows("CLINIC_MANAGER", visit.appointment.claim.clinic_id) or (
        principal.allows("DENTIST", visit.appointment.claim.clinic_id) and principal.employee_id == visit.main_dentist_id
    ):
        response["reason"] = row.reason
        response["summary"] = row.proposed_changes["summary"]
    approval = CorrectionApproval.objects.filter(correction=row).first()
    if approval:
        response["approval"] = {
            "decision": approval.decision, "reviewer_id": str(approval.reviewer_id),
            "decided_at": approval.decided_at.isoformat(),
        }
        if approval.decision == "APPROVED":
            proof = approval_evidence(row, invoice_id)
            if proof and proof.after_value.get("amount") is not None:
                response["approval"]["approved_signed_amount"] = proof.after_value["amount"]
        if "reason" in response:
            response["approval"]["reason"] = approval.reason
    response["allowed_actions"] = (
        (["decide"] if row.status == "PENDING" and principal.allows("CLINIC_MANAGER", visit.appointment.claim.clinic_id) else [])
        + (["apply"] if row.status == "APPROVED" and principal.allows("FRONT_DESK", visit.appointment.claim.clinic_id) else [])
    )
    return response


@api_view(["GET"])
def corrections(request):
    rows = accessible_corrections(request.user)
    state = request.query_params.get("status")
    if state:
        rows = rows.filter(status=state)
    return success({
        "items": [correction_data(row, request.user) for row in rows.order_by("-requested_at", "-pk")],
        "next_cursor": None,
    })


@api_view(["POST"])
def create(request, pk):
    visit = own_visit(request, pk)
    fields = values(EditRequest, request.data)
    key = OperationKey.from_request(request, command="request_correction", target={"visit_id": pk})
    row, created = new_correction(request.user, visit, fields, key)
    return success(correction_data(row, request.user), status_code=201 if created else 200)


@api_view(["POST"])
def decision(request, pk):
    row = get_object_or_404(accessible_corrections(request.user), pk=pk)
    request.user.require("CLINIC_MANAGER", row.visit.appointment.claim.clinic_id)
    fields = values(Approve, request.data)
    key = OperationKey.from_request(request, command="decide_correction", target={"correction_id": pk})
    return success(correction_data(review_correction(request.user, row, fields, key), request.user))


@api_view(["POST"])
def apply(request, pk):
    row = get_object_or_404(accessible_corrections(request.user), pk=pk)
    request.user.require("FRONT_DESK", row.visit.appointment.claim.clinic_id)
    fields = values(Apply, request.data)
    key = OperationKey.from_request(request, command="apply_correction", target={"correction_id": pk})
    result = apply_correction(request.user, row, fields, key)
    return success({
        "adjustment_id": str(result.pk), "correction_id": str(result.correction_id),
        "invoice_id": str(result.invoice_id), "signed_amount": amount_data(result.signed_amount),
    })


urlpatterns = [
    path("corrections", corrections),
    path("visits/<int:pk>/corrections", create),
    path("corrections/<int:pk>/decision", decision),
    path("corrections/<int:pk>/apply", apply),
]
