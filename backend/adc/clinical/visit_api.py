from django.shortcuts import get_object_or_404
from django.urls import path
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.appointment_query import accessible_appointments, appointment_projection
from adc.booking.models import DepositRefund
from adc.clinical.allergy_reviews import ReviewInput, allergy_context, save_review, visit_review_history
from adc.clinical.checkin_service import check_in_at
from adc.clinical.models import ChairUsage, MaterialUsage, TreatmentItem, Visit
from adc.clinical.visit_start import start_visit
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import ID, values
from adc.identity.models import AuditLog


class StartVisit(serializers.Serializer):
    expected_claim_id = ID()


def own_appointment(request, pk):
    request.user.require("DENTIST")
    return get_object_or_404(
        accessible_appointments(request.user), pk=pk, claim__dentist_id=request.user.employee_id,
        claim__clinic_id__in=request.user.clinic_scope("DENTIST"),
    )


def own_visit(request, pk):
    request.user.require("DENTIST")
    return get_object_or_404(
        Visit.objects.select_related("appointment__claim", "appointment__deposit"),
        pk=pk, main_dentist_id=request.user.employee_id,
        appointment__claim__clinic_id__in=request.user.clinic_scope("DENTIST"),
    )


def chair_projection(appointment):
    usage = ChairUsage.objects.select_related("chair").filter(appointment=appointment, released_at__isnull=True).first()
    return {"chair_id": str(usage.chair_id), "chair_no": usage.chair.chair_no} if usage else None


def name_snapshots(items):
    ids = [item.pk for item in items]
    audit = AuditLog.objects.filter(
        action="TREATMENT_ITEM_RECORDED", target_type="treatment_item", target_id__in=ids,
    ).order_by("id")
    return {row.target_id: row.after_value.get("treatment_name") for row in audit}


def visit_projection(entry, *, clinical):
    booking = entry.appointment
    actual_items = list(TreatmentItem.objects.filter(visit=entry).order_by("recorded_at", "pk"))
    snapshots = name_snapshots(actual_items)
    refund = DepositRefund.objects.filter(deposit_id=booking.deposit_id).first()
    result = {
        "visit_id": str(entry.pk), "appointment_id": str(entry.appointment_id), "appointment_no": booking.appointment_no,
        "status": entry.status, "started_at": entry.started_at.isoformat(),
        "ended_at": entry.ended_at.isoformat() if entry.ended_at else None,
        "chair": chair_projection(booking),
        "treatment_items": [
            {
                "item_id": str(item.pk), "treatment_type_id": str(item.treatment_type_id),
                "name": snapshots.get(item.pk), "units": format(item.units, ".3f"),
                "unit": item.unit_name_snapshot, "unit_price": format(item.unit_price_snapshot, ".2f"),
                "amount": format(item.amount, ".2f"),
            }
            for item in actual_items
        ],
        "estimated_amount": format(sum(item.amount for item in actual_items), ".2f"),
        "refund": (
            {"refund_id": str(refund.pk), "status": refund.status, "amount": format(refund.refund_amount, ".2f")}
            if refund else None
        ),
    }
    if clinical:
        from adc.billing.models import Invoice

        invoice_id = Invoice.objects.filter(visit=entry).values_list("pk", flat=True).first()
        result["invoice_id"] = str(invoice_id) if invoice_id else None
        result["patient_display"] = {"name": booking.claim.patient.full_name}
        result["clinic_name"] = booking.claim.clinic.clinic_name
        result["dentist_name"] = entry.main_dentist.full_name
        result["clinical_notes"] = entry.clinical_notes
        result["allergy_reviews"] = visit_review_history(entry)
        result["termination_reason"] = entry.termination_reason
        result["main_dentist_id"] = str(entry.main_dentist_id)
        result["planned_treatment_type_id"] = str(booking.claim.requested_treatment_type_id)
        result["additional_decisions"] = [
            {"decision_id": str(row.pk), "treatment_type_id": row.after_value["treatment_type_id"],
             "decision": row.after_value["decision"]}
            for row in AuditLog.objects.filter(
                action="ADDITIONAL_TREATMENT_DECISION", target_type="visit", target_id=entry.pk,
            ).order_by("pk")
        ]
        result["materials"] = [
            {
                "usage_id": str(row.pk), "item_id": str(row.treatment_item_id), "name": row.material.material_name,
                "unit": row.material.standard_unit, "quantity": format(row.quantity, ".3f"),
                "unit_cost": format(row.unit_cost_snapshot, ".2f"),
            }
            for row in MaterialUsage.objects.filter(treatment_item__visit=entry).select_related("material").order_by("pk")
        ]
    return result


@api_view(["GET"])
def queue(request):
    request.user.require("DENTIST")
    current = accessible_appointments(request.user).filter(
        claim__dentist_id=request.user.employee_id, status__in=("CHECKED_IN", "IN_TREATMENT"),
        claim__clinic_id__in=request.user.clinic_scope("DENTIST"),
    ).order_by("claim__start_at", "pk")
    entries = []
    for appointment in current:
        actual = Visit.objects.filter(appointment=appointment).first()
        entries.append({
            **appointment_projection(request.user, appointment), "chair": chair_projection(appointment),
            "visit_id": str(actual.pk) if actual else None, "check_in_at": check_in_at(appointment),
        })
    return success({"items": entries, "next_cursor": None})


@api_view(["GET"])
def context(request, pk):
    appointment = own_appointment(request, pk)
    if appointment.status not in {"CONFIRMED", "CHECKED_IN", "IN_TREATMENT"}:
        raise ApiProblem(409, "INVALID_TRANSITION", "当前预约不在接诊准备或诊疗期间。")
    claim = appointment.claim
    history = Visit.objects.filter(
        appointment__claim__patient_id=claim.patient_id, status__in=("COMPLETED", "TERMINATED"),
    ).order_by("-ended_at", "-pk")
    return success({
        "appointment": appointment_projection(request.user, appointment),
        "chair": chair_projection(appointment), "special_requirement": appointment.special_requirement,
        **allergy_context(claim.patient_id),
        "history": [
            {"visit_id": str(row.pk), "status": row.status, "ended_at": row.ended_at.isoformat(),
             "clinical_notes": row.clinical_notes}
            for row in history
        ],
    })


@api_view(["POST"])
def allergy_review(request, pk):
    appointment = own_appointment(request, pk)
    fields = values(ReviewInput, request.data)
    operation = OperationKey.from_request(request, command="review_allergies", target={"appointment_id": pk})
    result, created = save_review(request.user, appointment, fields, operation)
    return success(result, status_code=201 if created else 200)


@api_view(["POST"])
def start(request, pk):
    appointment = own_appointment(request, pk)
    fields = values(StartVisit, request.data)
    operation = OperationKey.from_request(request, command="start_visit", target={"appointment_id": pk})
    entry, created = start_visit(request.user, appointment, fields, operation)
    return success(visit_projection(entry, clinical=True), status_code=201 if created else 200)


@api_view(["GET"])
def detail(request, pk):
    principal = request.user
    if principal.channel != "staff" or not (principal.allows("DENTIST") or principal.allows("FRONT_DESK")):
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能访问就诊资料。")
    record = get_object_or_404(
        Visit.objects.select_related("appointment__claim", "appointment__deposit"),
        pk=pk, appointment__in=accessible_appointments(principal),
    )
    clinical = principal.allows("DENTIST", record.appointment.claim.clinic_id) and record.main_dentist_id == principal.employee_id
    if not clinical:
        principal.require("FRONT_DESK", record.appointment.claim.clinic_id)
    data = visit_projection(record, clinical=clinical)
    data["can_issue_invoice"] = record.status in {"COMPLETED", "TERMINATED"} and principal.allows(
        "FRONT_DESK", record.appointment.claim.clinic_id,
    )
    return success(data)


urlpatterns = [
    path("clinical/queue", queue),
    path("appointments/<int:pk>/clinical-context", context),
    path("appointments/<int:pk>/allergy-reviews", allergy_review),
    path("appointments/<int:pk>/start-visit", start),
    path("visits/<int:pk>", detail),
]
