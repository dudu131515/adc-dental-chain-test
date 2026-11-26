from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from adc.booking.models import AppointmentRequestedTreatment
from adc.catalog.models import TreatmentType
from adc.catalog.services import price_on_local_date
from adc.clinical.material_costs import (
    effective_material_costs, legacy_amounts, legacy_cost_versions, managed_reference, missing_cost,
)
from adc.clinical.models import Material, MaterialUsage, TreatmentItem, Visit
from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.master_data_write import lock_master_rows
from adc.identity.models import AuditLog
from adc.reporting.period_locks import BUSINESS_ZONE


CENTS = Decimal("0.01")


def applied_materials(fields, business_date):
    if not fields:
        return []
    material_ids = {entry["material_id"] for entry in fields}
    lock_master_rows(Material, material_ids)
    materials = {
        row.pk: row for row in Material.objects.filter(pk__in=material_ids, status="ACTIVE")
    }
    if material_ids != materials.keys():
        raise ApiProblem(404, "NOT_FOUND", "找不到可使用的耗材。")
    managed = {
        cost.material_id: cost for cost in effective_material_costs(business_date).filter(material_id__in=material_ids)
    }
    legacy = legacy_cost_versions() if material_ids - managed.keys() else {}
    applied = []
    for entry in fields:
        material = materials[entry["material_id"]]
        reference = entry["cost_evidence_ref"]
        cost = managed.get(material.pk)
        if cost:
            if reference != managed_reference(cost.pk):
                raise missing_cost()
            amount = cost.unit_cost
        else:
            matching = list(legacy_amounts(legacy, material, business_date, reference))
            if len(matching) != 1:
                raise missing_cost()
            amount = matching[0]
        applied.append((material, entry["quantity"], amount, reference))
    return applied


def lock_visit(first, principal):
    current = Visit.objects.select_for_update().get(pk=first.pk)
    if current.main_dentist_id != principal.employee_id:
        raise ApiProblem(403, "PERMISSION_DENIED", "当前账号不能登记本次诊疗。")
    return current


def require_in_progress(visit):
    if visit.status != "IN_PROGRESS":
        raise ApiProblem(409, "INVALID_TRANSITION", "仅负责牙医可操作正在进行的本次诊疗。")


def save_decision(principal, original, fields, operation):
    with transaction.atomic():
        visit = lock_visit(original, principal)
        result = operation.result_id(fields)
        if result is not None:
            return AuditLog.objects.get(pk=result), False
        require_in_progress(visit)
        treatment = get_object_or_404(TreatmentType, pk=fields["treatment_type_id"], active=True)
        projection = {
            "treatment_type_id": str(treatment.pk),
            "decision": fields["decision"],
            "evidence_ref": fields["evidence_ref"],
        }
        record = record_event(
            account_id=principal.account_id, action="ADDITIONAL_TREATMENT_DECISION",
            target_type="visit", target_id=visit.pk, visible_fields=projection.keys(), after=projection,
        )
        operation.record_result(record.pk, fields)
        return record, True


def additional_consent(visit, project, fields):
    is_new = (
        visit.appointment.claim.requested_treatment_type_id != project.pk
        and not AppointmentRequestedTreatment.objects.filter(
            appointment_id=visit.appointment_id, treatment_type=project,
        ).exists()
    )
    is_additional = bool(fields.get("is_additional")) or is_new
    if not is_additional:
        return False, None
    decision_id = fields.get("decision_id")
    approved = AuditLog.objects.filter(
        pk=decision_id, action="ADDITIONAL_TREATMENT_DECISION", target_type="visit", target_id=visit.pk,
        after_value__treatment_type_id=str(project.pk), after_value__decision="ACCEPTED",
    ).first()
    if not approved:
        raise ApiProblem(409, "EVIDENCE_REQUIRED", "追加项目须先取得患者对该项目的同意。")
    return True, approved


def save_item(principal, original, fields, operation):
    with transaction.atomic():
        visit = lock_visit(original, principal)
        result = operation.result_id(fields)
        if result is not None:
            return TreatmentItem.objects.get(pk=result), False
        require_in_progress(visit)
        project = get_object_or_404(TreatmentType, pk=fields["treatment_type_id"], active=True)
        is_additional, consent = additional_consent(visit, project, fields)
        now = timezone.now()
        at = fields.get("performed_at") or now
        if at < visit.started_at or at > now:
            raise ApiProblem(400, "VALIDATION_ERROR", "治疗实施时点须处于本次实际诊疗期间。")
        if consent and consent.occurred_at > at:
            raise ApiProblem(409, "EVIDENCE_REQUIRED", "追加项目的同意须先于实际实施。")
        business_date = at.astimezone(BUSINESS_ZONE).date()
        price = price_on_local_date(project.pk, business_date)
        if price is None:
            raise ApiProblem(409, "EVIDENCE_REQUIRED", "实际实施日缺少有效项目单价。")
        units = fields["units"]
        amount = (units * price.unit_price).quantize(CENTS, rounding=ROUND_HALF_UP)
        if amount > Decimal("999999999999.99"):
            raise ApiProblem(400, "VALIDATION_ERROR", "治疗数量与单价对应的金额超出计费精度。")
        usage = applied_materials(fields.get("materials", []), business_date)
        saved = TreatmentItem.objects.create(
            visit=visit, treatment_type=project, performing_dentist_id=principal.employee_id,
            tooth_code=fields.get("tooth_code"), units=units, unit_name_snapshot=project.standard_unit,
            unit_price_snapshot=price.unit_price, amount=amount, patient_consented=is_additional,
            is_additional=is_additional, recorded_at=now,
        )
        references = []
        for material, quantity, unit_cost, evidence in usage:
            row = MaterialUsage.objects.create(
                treatment_item=saved, material=material, quantity=quantity, unit_cost_snapshot=unit_cost,
                material_name_snapshot=material.material_name, unit_name_snapshot=material.standard_unit,
            )
            references.append({"usage_id": str(row.pk), "reference": evidence})
        details = {
            "visit_id": str(visit.pk), "treatment_name": project.treatment_name, "price_id": str(price.pk),
            "performed_at": at.isoformat(), "consent_id": str(consent.pk) if consent else None,
            "material_evidence": references,
        }
        record_event(
            account_id=principal.account_id, action="TREATMENT_ITEM_RECORDED", target_type="treatment_item",
            target_id=saved.pk, visible_fields=details.keys(), after=details,
        )
        operation.record_result(saved.pk, fields)
        return saved, True
