from uuid import uuid4

from django.db import transaction
from django.db.models import OuterRef, Q, Subquery
from django.shortcuts import get_object_or_404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view

from adc.booking.models import Appointment
from adc.common.http import ApiProblem, success
from adc.common.idempotency import OperationKey
from adc.common.serializers import values
from adc.identity.api import PatientProfile
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Clinic, Patient


def front_patient_projection(record):
    return {
        "patient_id": str(record.pk), "patient_no": record.patient_no, "full_name": record.full_name,
        "birth_date": record.birth_date.isoformat(), "phone": record.phone,
    }


def own_profile(record):
    return {
        **front_patient_projection(record), "billing_address": record.billing_address,
        "email": record.email, "emergency_name": record.emergency_name, "emergency_phone": record.emergency_phone,
    }


def patients_in_clinic(clinic_id):
    prior_records = Appointment.objects.filter(claim__clinic_id=clinic_id).values("claim__patient_id")
    registrations = AuditLog.objects.filter(
        action="FRONT_DESK_PATIENT_REGISTERED", target_type="patient", after_value__clinic_id=str(clinic_id),
    ).values("target_id")
    return Patient.objects.filter(Q(pk__in=prior_records) | Q(pk__in=registrations))


@api_view(["GET", "PATCH"])
def my_profile(request):
    principal = request.user
    if principal.channel != "patient" or not principal.patient_id:
        raise ApiProblem(403, "PERMISSION_DENIED", "请通过患者本人账号访问。")
    if request.method == "GET":
        return success(own_profile(get_object_or_404(Patient, pk=principal.patient_id)))
    changes = values(PatientProfile, request.data, partial=True)
    if not changes:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择需要修改的本人资料。")
    with transaction.atomic():
        record = get_object_or_404(Patient.objects.select_for_update(), pk=principal.patient_id)
        for field, value in changes.items():
            setattr(record, field, value)
        record.save(update_fields=tuple(changes))
        record_event(
            account_id=principal.account_id, action="PATIENT_PROFILE_CHANGED", target_type="patient",
            target_id=record.pk, visible_fields=("fields",), after={"fields": sorted(changes)},
        )
    return success(own_profile(record))


@api_view(["GET", "POST"])
def clinic_patients(request, pk):
    request.user.require("FRONT_DESK", pk)
    get_object_or_404(Clinic, pk=pk, status="ACTIVE")
    if request.method == "GET":
        text = request.query_params.get("q", "").strip()
        patients = patients_in_clinic(pk)
        if text:
            patients = patients.filter(Q(full_name__icontains=text) | Q(patient_no__iexact=text) | Q(phone=text))
        return success({
            "items": [front_patient_projection(record) for record in patients.order_by("patient_no")],
            "next_cursor": None,
        })
    data = values(PatientProfile, request.data)
    operation = None
    if request.headers.get("Idempotency-Key"):
        operation = OperationKey.from_request(request, command="clinic_patient", target={"clinic_id": pk})
    with transaction.atomic():
        Clinic.objects.select_for_update().get(pk=pk)
        prior = operation.result_id(data) if operation else None
        if prior:
            return success(front_patient_projection(Patient.objects.get(pk=prior)))
        record = Patient.objects.create(patient_no=f"P-{uuid4().hex.upper()}", **data)
        record_event(
            account_id=request.user.account_id, action="FRONT_DESK_PATIENT_REGISTERED",
            target_type="patient", target_id=record.pk, visible_fields=("clinic_id",),
            after={"clinic_id": str(pk)},
        )
        if operation:
            operation.record_result(record.pk, data)
    return success(front_patient_projection(record), status_code=201)


class DirectoryFilters(serializers.Serializer):
    q = serializers.CharField(max_length=120, required=False, allow_blank=True)
    page = serializers.IntegerField(min_value=1, max_value=1000000, default=1)


def page_result(query, page, project):
    page_size = 20
    offset = (page - 1) * page_size
    return {"total": query.count(), "page": page, "page_size": page_size,
            "items": [project(row) for row in query[offset:offset + page_size]]}


def front_registry(request, clinic_id):
    request.user.require("FRONT_DESK", clinic_id)
    get_object_or_404(Clinic, pk=clinic_id, status="ACTIVE")
    return patients_in_clinic(clinic_id)


@api_view(["GET"])
def patient_directory(request, pk):
    patients = front_registry(request, pk)
    filters = values(DirectoryFilters, request.query_params)
    search = filters.get("q", "")
    if search:
        patients = patients.filter(Q(full_name__icontains=search) | Q(patient_no__iexact=search) | Q(phone=search))
    upcoming = Appointment.objects.filter(
        claim__patient_id=OuterRef("pk"), claim__clinic_id=pk,
        claim__start_at__gte=timezone.now(), status="CONFIRMED",
    ).order_by("claim__start_at", "pk")
    patients = patients.annotate(next_start=Subquery(upcoming.values("claim__start_at")[:1]))
    return success(page_result(patients.order_by("full_name", "pk"), filters["page"], lambda row: {
        **front_patient_projection(row), "next_start": row.next_start.isoformat() if row.next_start else None,
    }))


@api_view(["GET"])
def patient_record(request, pk, patient_id):
    patient = get_object_or_404(front_registry(request, pk), pk=patient_id)
    page = values(DirectoryFilters, request.query_params)["page"]
    history = Appointment.objects.filter(claim__patient=patient, claim__clinic_id=pk).select_related(
        "claim__requested_treatment_type", "claim__dentist",
    ).order_by("-claim__start_at", "-pk")
    result = page_result(history, page, lambda row: {
        "appointment_id": str(row.pk), "appointment_no": row.appointment_no, "status": row.status,
        "start_at": row.claim.start_at.isoformat(), "dentist": row.claim.dentist.full_name,
        "treatment": row.claim.requested_treatment_type.treatment_name,
    })
    return success({"patient": front_patient_projection(patient), "appointments": result.pop("items"), **result})


urlpatterns = [
    path("clinics/<int:pk>/patient-directory", patient_directory),
    path("clinics/<int:pk>/patients/<int:patient_id>", patient_record),
    path("patients/me", my_profile),
    path("clinics/<int:pk>/patients", clinic_patients),
]
