from django.db import transaction
from rest_framework import serializers

from adc.booking.models import Appointment
from adc.clinical.models import PatientAllergy, Visit
from adc.common.http import ApiProblem
from adc.common.serializers import ID
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Patient


REVIEW_ACTION = "PATIENT_ALLERGY_REVIEWED"


class AllergyEntry(serializers.Serializer):
    allergen = serializers.CharField(max_length=120)
    notes = serializers.CharField(required=False, allow_blank=True, allow_null=True, default="")


class ReviewInput(serializers.Serializer):
    expected_claim_id = ID()
    expected_version = serializers.IntegerField(min_value=0, max_value=2**63 - 1)
    status = serializers.ChoiceField(choices=("KNOWN", "NONE_KNOWN"))
    allergies = AllergyEntry(many=True)

    def validate(self, data):
        entries = data["allergies"]
        if bool(entries) != (data["status"] == "KNOWN"):
            raise serializers.ValidationError({"allergies": "已知过敏须填写过敏原，确认无已知过敏时应提交空列表。"})
        names = [entry["allergen"].casefold() for entry in entries]
        if len(names) != len(set(names)):
            raise serializers.ValidationError({"allergies": "过敏原重复，请合并同一过敏原的说明。"})
        return data


def reviews(patient_id):
    return AuditLog.objects.filter(
        action=REVIEW_ACTION, target_type="patient", target_id=patient_id,
    ).select_related("account__employee").order_by("-pk")


def review_summary(event):
    facts = event.after_value
    return {
        "review_id": str(event.pk), "status": facts["status"], "appointment_id": facts["appointment_id"],
        "dentist_name": event.account.employee.full_name, "reviewed_at": event.occurred_at.isoformat(),
        "changes": {kind: len(facts[kind]) for kind in ("added", "updated", "removed")},
    }


def lock_patient(patient_id):
    # Even the first review, with no existing allergy or audit rows, shares this lock.
    Patient.objects.select_for_update(no_key=True).values_list("pk", flat=True).get(pk=patient_id)


def current_status(rows, last_event):
    if rows:
        return "KNOWN"
    if last_event and last_event.after_value["status"] == "NONE_KNOWN":
        return "NONE_KNOWN"
    return "UNVERIFIED"


@transaction.atomic
def allergy_context(patient_id, clinic_id):
    lock_patient(patient_id)
    rows = list(PatientAllergy.objects.filter(patient_id=patient_id).order_by("allergen_name"))
    history = list(reviews(patient_id))
    latest = history[0] if history else None
    appointment_ids = {event.after_value["appointment_id"] for event in history}
    local_ids = {str(pk) for pk in Appointment.objects.filter(
        pk__in=appointment_ids, claim__clinic_id=clinic_id,
    ).values_list("pk", flat=True)}
    return {
        "allergies": [{"allergen": row.allergen_name, "notes": row.notes} for row in rows],
        "allergy_review": {
            "status": current_status(rows, latest), "version": str(latest.pk if latest else 0),
            "history": [review_summary(event) for event in history if event.after_value["appointment_id"] in local_ids],
        },
    }


def visit_review_history(visit):
    return [
        review_summary(event) for event in reviews(visit.appointment.claim.patient_id)
        .filter(after_value__appointment_id=str(visit.appointment_id))
    ]


def replace_allergies(patient_id, rows, entries):
    existing = {row.allergen_name: row for row in rows}
    added, updated = [], []
    for entry in entries:
        name, notes = entry["allergen"], entry.get("notes") or None
        row = existing.pop(name, None)
        if row is None:
            row = PatientAllergy.objects.create(patient_id=patient_id, allergen_name=name, notes=notes)
            added.append(str(row.pk))
        elif (row.notes or None) != notes:
            row.notes = notes
            row.save(update_fields=("notes",))
            updated.append(str(row.pk))
    removed = [str(row.pk) for row in existing.values()]
    if removed:
        PatientAllergy.objects.filter(patient_id=patient_id, pk__in=removed).delete()
    return {"added": added, "updated": updated, "removed": removed}


@transaction.atomic
def save_review(principal, original, fields, operation):
    # Rescheduling, starting and closing also lock the appointment before changing it.
    booking = Appointment.objects.select_for_update(of=("self",)).select_related("claim").get(pk=original.pk)
    claim = booking.claim
    if claim.dentist_id != principal.employee_id or not principal.allows("DENTIST", claim.clinic_id):
        raise ApiProblem(404, "NOT_FOUND", "找不到本人负责的预约。")
    if claim.pk != fields["expected_claim_id"]:
        raise ApiProblem(409, "STALE_APPOINTMENT", "预约安排已变更，请重新核对。")
    lock_patient(claim.patient_id)
    prior = operation.result_id(fields)
    events = reviews(claim.patient_id)
    if prior is not None:
        return review_summary(events.get(pk=prior)), False

    if booking.status not in {"CHECKED_IN", "IN_TREATMENT"} or claim.status != "CONFIRMED":
        raise ApiProblem(409, "INVALID_TRANSITION", "仅可在患者签到后至本次诊疗结束前登记过敏核对。")
    if booking.status == "IN_TREATMENT" and not Visit.objects.filter(
        appointment=booking, main_dentist_id=principal.employee_id, status="IN_PROGRESS",
    ).exists():
        raise ApiProblem(409, "INVALID_TRANSITION", "未找到本人进行中的对应诊疗。")
    latest = events.first()
    if fields["expected_version"] != (latest.pk if latest else 0):
        raise ApiProblem(409, "STALE_ALLERGY_REVIEW", "患者过敏记录已更新，请重新读取并与患者核对。")

    rows = list(PatientAllergy.objects.filter(patient_id=claim.patient_id))
    before = {"status": current_status(rows, latest)}
    changes = replace_allergies(claim.patient_id, rows, fields["allergies"])
    after = {"status": fields["status"], "appointment_id": str(booking.pk), **changes}
    # Keep clinical text in A.11; the audit records the actor, state and affected row IDs.
    event = record_event(
        account_id=principal.account_id, action=REVIEW_ACTION, target_type="patient", target_id=claim.patient_id,
        visible_fields=after.keys(), before=before, after=after,
    )
    operation.record_result(event.pk, fields)
    return review_summary(event), True
