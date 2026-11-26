import type { AllergyEntry, AllergyReview, AllergyReviewState, ClinicalContext, Visit } from "../src/features/clinical/clinicalTypes";
import type { Appointment, Chair, FundsStatus } from "../src/features/schedule/appointmentTypes";
import { ApiError } from "../src/shared/api";
import { invoices, type Appointment as Fixture } from "./fixtures";
import { sampleMaterials, type SampleMaterial } from "./sampleMasterData";

type Body = Record<string, unknown>;
type Resource = Chair & {
  clinic_id: string; status: string; unavailability: {start_at: string; end_at: string}[];
};
type Treatment = {
  treatment_type_id: string; treatment_name: string; standard_unit: string;
  current_unit_price: string | null; required_chair_kind?: string | null; active?: boolean;
};
export type SampleClinicalActor = {
  allowed: (roles: string[], clinic?: string) => boolean;
  authorize: (roles: string[], clinic?: string) => void;
  dentist: () => string;
};
type Options = {
  appointments: Fixture[]; chairs: Resource[]; treatments: Treatment[];
  appointment: (row: Fixture, actor?: SampleClinicalActor) => Appointment;
  specialRequirement?: (id: string) => string | undefined;
  materialsFor?: (day: string) => SampleMaterial[];
  id: () => string; clockDate: string;
};
type VisitRecord = {
  id: string; row: Fixture; status: string; startedAt: string; endedAt?: string;
  notes?: string; reason?: string; refund?: FundsStatus; seeded: boolean;
  items: Visit["treatment_items"]; materials: NonNullable<Visit["materials"]>;
  decisions: NonNullable<Visit["additional_decisions"]>;
};
type ReviewRecord = {clinic: string; summary: AllergyReview};

const frontDesk = ["FRONT_DESK"];
const dentistRole = ["DENTIST"];
const clinicalRoles = ["DENTIST", "FRONT_DESK"];
const usableChair = (row: Resource) => row.status === "AVAILABLE" || row.status === "ACTIVE";

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, {code, message});
}

function requireMethod(method: string, expected: string) {
  if (method !== expected) fail(405, "METHOD_NOT_ALLOWED", "此操作不支持当前请求方式。");
}

const iso = (date: string, time: string) => `${date}T${time}:00+08:00`;
const plus = (value: string, minutes: number) => new Date(Date.parse(value) + minutes * 60_000).toISOString();
const money = (amount: number) => amount.toFixed(2);
const input = (value: unknown) => typeof value === "string" ? value.trim() : "";
const needsChair = (row: Fixture) => row.status === "arrived" || row.status === "treating";
const overlap = (start: number, end: number, other: {start_at: string; end_at: string}) =>
  start < Date.parse(other.end_at) && Date.parse(other.start_at) < end;

function quantity(value: unknown, minimum: number) {
  const raw = typeof value === "number" ? String(value) : input(value);
  if (!/^(?:\d{1,9}(?:\.\d{0,3})?|\.\d{1,3})$/.test(raw) || Number(raw) < minimum) {
    fail(400, "VALIDATION_ERROR", "请填写有效的治疗数量或耗材用量。");
  }
  return Number(raw).toFixed(3);
}

export function createSampleClinical({appointments, chairs, appointment, specialRequirement, id, clockDate,
  treatments, materialsFor=()=>sampleMaterials}: Options) {
  const visits = new Map<string, VisitRecord>();
  const visitsByAppointment = new Map<string, VisitRecord>();
  const assignments = new Map<string, string>();
  const knownChairs = new Set<string>();
  const checkIns = new Map<string, string>();
  const allergies = new Map<string, AllergyEntry[]>();
  const reviews = new Map<string, ReviewRecord[]>();
  let sequence = 0;

  const actionTime = (row: Fixture) => new Date(Math.max(Date.parse(iso(row.date, row.time)),
    Date.parse(iso(clockDate, "08:00"))) + ++sequence * 1000).toISOString();

  function remember(entry: VisitRecord) {
    visits.set(entry.id, entry);
    visitsByAppointment.set(entry.row.id, entry);
    return entry;
  }

  for (const [index, row] of appointments.entries()) {
    if (row.allergy && !allergies.has(row.patientId)) allergies.set(row.patientId, [{allergen:row.allergy}]);
    const start = iso(row.date, row.time);
    if (row.status === "arrived" || row.status === "treating" || row.status === "done") {
      checkIns.set(row.id, plus(start, -10));
    }
    if (row.status !== "done" && row.status !== "treating") continue;
    const completed = row.status === "done";
    const project = treatments.find(treatment => treatment.treatment_name === row.service);
    const savedPrice = money((row.invoice ? invoices[row.invoice]?.due : undefined) ?? Number(project?.current_unit_price ?? "0"));
    const items = project && completed ? [{item_id:"seed-"+row.id,treatment_type_id:project.treatment_type_id,
      name:project.treatment_name,units:"1.000",unit:project.standard_unit,unit_price:savedPrice,amount:savedPrice}] : [];
    const visitId = String(index + 1);
    remember({id:visitId,row,status:completed ? "COMPLETED" : "IN_PROGRESS",startedAt:start,
      endedAt:completed ? plus(start, 30) : undefined,items,materials:[],decisions:[],seeded:true,
      refund:{refund_id:visitId,amount:"50.00",status:"SUCCEEDED"}});
    if (!completed) {
      const chair = chairs.find(resource => resource.clinic_id === row.clinic && usableChair(resource)
        && !appointments.some(other => other.date === row.date && assignments.get(other.id) === resource.chair_id));
      if (chair) { assignments.set(row.id, chair.chair_id); knownChairs.add(chair.chair_id); }
    }
  }

  const visitIdForAppointment = (appointmentId: string) => visitsByAppointment.get(appointmentId)?.id;
  const refundForAppointment = (appointmentId: string) => visitsByAppointment.get(appointmentId)?.refund;
  const checkInAt = (appointmentId: string) => checkIns.get(appointmentId);

  function chairForAppointment(appointmentId: string): Chair | null {
    const row = chairs.find(chair => chair.chair_id === assignments.get(appointmentId));
    return row ? {chair_id:row.chair_id,chair_no:row.chair_no,chair_kind:row.chair_kind} : null;
  }

  function visitReviewHistory(row: Fixture) {
    return (reviews.get(row.patientId) ?? []).filter(review => review.clinic === row.clinic
      && review.summary.appointment_id === row.id).map(review => review.summary);
  }

  function projectVisit(entry: VisitRecord, actor?: SampleClinicalActor): Visit {
    const {row} = entry;
    const booking = appointment(row, actor);
    return {
      visit_id:entry.id, appointment_id:booking.appointment_id, appointment_no:booking.appointment_no,
      status:entry.status, started_at:entry.startedAt, ended_at:entry.endedAt,
      chair:chairForAppointment(row.id) ?? undefined, refund:entry.refund, treatment_items:entry.items,
      estimated_amount:money(entry.items.reduce((total, item) => total + Math.round(Number(item.amount) * 100), 0) / 100),
      invoice_id:row.invoice, patient_display:{name:row.patient}, clinic_name:booking.clinic.name,
      dentist_name:booking.dentist.name, main_dentist_id:booking.dentist.dentist_id,
      clinical_notes:entry.notes, termination_reason:entry.reason, allergy_reviews:visitReviewHistory(row),
      planned_treatment_type_id:booking.treatment.treatment_type_id, additional_decisions:entry.decisions, materials:entry.materials,
    };
  }

  function visit(id: string) {
    const entry = visits.get(id) ?? visitsByAppointment.get(id);
    return entry && projectVisit(entry);
  }

  function visitForAppointment(appointmentId: string) {
    const entry = visitsByAppointment.get(appointmentId);
    return entry && projectVisit(entry);
  }

  function isOwner(row: Fixture, actor: SampleClinicalActor) {
    return actor.allowed(dentistRole, row.clinic) && appointment(row, actor).dentist.dentist_id === actor.dentist();
  }

  function verifyClaim(booking: Appointment, body: Body) {
    if (String(body.expected_claim_id ?? "") !== booking.claim_id) {
      fail(409, "STALE_APPOINTMENT", "预约安排已变化，请刷新核对。");
    }
  }

  function availableChairs(row: Fixture, booking: Appointment) {
    if (!needsChair(row)) fail(409, "INVALID_TRANSITION", "请先为有效预约签到。");
    const start = Math.max(Date.parse(booking.start_at), Date.parse(iso(clockDate, "08:00")));
    const end = Math.max(Date.parse(booking.end_at), start + 1);
    const kind = treatments.find(treatment => treatment.treatment_type_id === booking.treatment.treatment_type_id)?.required_chair_kind;
    return chairs.filter(chair => chair.clinic_id === row.clinic && usableChair(chair)
      && (!kind || chair.chair_kind === kind)
      && !chair.unavailability.some(period => overlap(start, end, period))
      && !appointments.some(other => other.id !== row.id && other.date === row.date
        && assignments.get(other.id) === chair.chair_id && needsChair(other)))
      .map(chair => ({chair_id:chair.chair_id,chair_no:chair.chair_no,chair_kind:chair.chair_kind}))
      .sort((left, right) => left.chair_no.localeCompare(right.chair_no));
  }

  function startVisit(row: Fixture, booking: Appointment, actor: SampleClinicalActor) {
    const previous = visitsByAppointment.get(row.id);
    if (previous) return projectVisit(previous, actor);
    if (row.status !== "arrived") fail(409, "INVALID_TRANSITION", "请先核验有效预约、签到并分配牙椅。");
    if (!availableChairs(row, booking).some(chair => chair.chair_id === assignments.get(row.id))) {
      fail(409, "RESOURCE_CONFLICT", "当前牙椅不可用，请先核对分椅。");
    }
    if ([...visits.values()].some(entry => entry.status === "IN_PROGRESS" && (!entry.seeded || entry.row.date === row.date)
      && appointment(entry.row).dentist.dentist_id === booking.dentist.dentist_id)) {
      fail(409, "RESOURCE_CONFLICT", "本人已有进行中的实际诊疗。");
    }
    const {deposit} = appointment(row);
    const refund = deposit?.status === "PAID" ? {refund_id:id(),amount:deposit.amount,status:"SUCCEEDED"} : undefined;
    const entry = remember({id:id(),row,status:"IN_PROGRESS",startedAt:actionTime(row),items:[],materials:[],decisions:[],seeded:false,refund});
    row.status = "treating";
    return projectVisit(entry, actor);
  }

  function allergyState(row: Fixture): AllergyReviewState {
    const existing = reviews.get(row.patientId) ?? [];
    return {version:existing[0]?.summary.review_id ?? "0",
      status:allergies.get(row.patientId)?.length ? "KNOWN" : existing[0]?.summary.status ?? "UNVERIFIED",
      history:existing.filter(review => review.clinic === row.clinic).map(review => review.summary)};
  }

  function saveReview(row: Fixture, booking: Appointment, body: Body): AllergyReview {
    if (!needsChair(row)) fail(409, "INVALID_TRANSITION", "仅可在患者签到后至本次诊疗结束前登记过敏核对。");
    if (String(body.expected_version ?? "") !== allergyState(row).version) {
      fail(409, "STALE_ALLERGY_REVIEW", "患者过敏记录已更新，请重新读取并与患者核对。");
    }
    if ((body.status !== "KNOWN" && body.status !== "NONE_KNOWN") || !Array.isArray(body.allergies)
      || Boolean(body.allergies.length) !== (body.status === "KNOWN")) {
      fail(400, "VALIDATION_ERROR", "请根据核对结果填写过敏原。");
    }
    const entries = body.allergies.map((raw: unknown) => {
      const entry = raw && typeof raw === "object" ? raw as Body : {};
      const allergen = input(entry.allergen);
      if (!allergen || allergen.length > 120) fail(400, "VALIDATION_ERROR", "请填写有效的过敏原。");
      return {allergen,notes:input(entry.notes) || null};
    }).sort((left, right) => left.allergen.localeCompare(right.allergen));
    if (new Set(entries.map(entry => entry.allergen.toLowerCase())).size !== entries.length) {
      fail(400, "VALIDATION_ERROR", "同一过敏原请只登记一次。");
    }
    const before = allergies.get(row.patientId) ?? [];
    const previous = new Map(before.map(entry => [entry.allergen,entry.notes ?? null]));
    const current = new Set(entries.map(entry => entry.allergen));
    const summary: AllergyReview = {review_id:id(),appointment_id:booking.appointment_id,status:body.status,
      dentist_name:booking.dentist.name,reviewed_at:actionTime(row),changes:{
        added:entries.filter(entry => !previous.has(entry.allergen)).length,
        updated:entries.filter(entry => previous.has(entry.allergen) && previous.get(entry.allergen) !== entry.notes).length,
        removed:before.filter(entry => !current.has(entry.allergen)).length,
      }};
    allergies.set(row.patientId, entries);
    reviews.set(row.patientId, [{clinic:row.clinic,summary}, ...(reviews.get(row.patientId) ?? [])]);
    return summary;
  }

  function context(row: Fixture, booking: Appointment, actor: SampleClinicalActor): ClinicalContext {
    if (row.status !== "booked" && !needsChair(row)) fail(409, "INVALID_TRANSITION", "当前预约不在接诊准备或诊疗期间。");
    const history = [...visits.values()].filter(entry => entry.row.id !== row.id && entry.row.patientId === row.patientId
      && entry.row.clinic === row.clinic && entry.endedAt).sort((left, right) => Date.parse(right.endedAt!) - Date.parse(left.endedAt!));
    return {appointment:booking,chair:chairForAppointment(row.id),special_requirement:specialRequirement?.(row.id) ?? null,
      allergies:allergies.get(row.patientId) ?? [],allergy_review:allergyState(row),history:history.map(entry => ({
        visit_id:entry.id,status:entry.status,ended_at:entry.endedAt!,
        treatments:[...new Set(entry.items.map(item => item.name))],can_open_detail:isOwner(entry.row, actor),
      }))};
  }

  function saveTreatment(entry: VisitRecord, booking: Appointment, body: Body) {
    const project = treatments.find(treatment => treatment.treatment_type_id === String(body.treatment_type_id)
      && treatment.active !== false);
    if (!project || project.current_unit_price === null) fail(409, "EVIDENCE_REQUIRED", "当前项目缺少可使用的目录及价格。");
    const treatmentType = project.treatment_type_id;
    const additional = body.is_additional === true || treatmentType !== booking.treatment.treatment_type_id;
    if (additional && !entry.decisions.some(decision => decision.decision_id === String(body.decision_id)
      && decision.treatment_type_id === treatmentType && decision.decision === "ACCEPTED")) {
      fail(409, "EVIDENCE_REQUIRED", "请先登记该追加项目的患者同意。");
    }
    const units = quantity(body.units, 0.001);
    if (body.materials !== undefined && !Array.isArray(body.materials)) fail(400, "VALIDATION_ERROR", "请填写有效的耗材记录。");
    const materialInput: unknown[] = Array.isArray(body.materials) ? body.materials : [];
    const materialRows = materialInput.map(raw => {
      const use = raw && typeof raw === "object" ? raw as Body : {};
      const material = materialsFor(entry.row.date).find(choice => choice.material_id === String(use.material_id)
        && choice.reference === use.cost_evidence_ref);
      if (!material) fail(400, "EVIDENCE_REQUIRED", "请核对耗材与成本凭据。");
      return {name:material.material_name,unit:material.standard_unit,quantity:quantity(use.quantity, 0),unit_cost:material.cost};
    });
    const priceCents = BigInt(Math.round(Number(project.current_unit_price) * 100));
    const unitThousandths = BigInt(units.replace(".", ""));
    const amountCents = (priceCents * unitThousandths + 500n) / 1000n;
    if (amountCents > 99999999999999n) fail(400, "VALIDATION_ERROR", "治疗数量与单价对应的金额超出计费精度。");
    const amount = money(Number(amountCents) / 100);
    const item = {item_id:id(),treatment_type_id:treatmentType,name:project.treatment_name,units,
      unit:project.standard_unit,unit_price:project.current_unit_price,amount};
    entry.items.push(item);
    entry.materials.push(...materialRows.map(material => ({...material,usage_id:id(),item_id:item.item_id})));
    return {...item,is_additional:additional};
  }

  function decision(entry: VisitRecord, body: Body) {
    const project = treatments.find(treatment => treatment.treatment_type_id === String(body.treatment_type_id)
      && treatment.active !== false);
    if (!project || (body.decision !== "ACCEPTED" && body.decision !== "DECLINED") || !input(body.evidence_ref)) {
      fail(400, "EVIDENCE_REQUIRED", "请核对追加项目并填写患者决定凭据。");
    }
    const saved = {decision_id:id(),treatment_type_id:project.treatment_type_id,decision:body.decision};
    entry.decisions.push(saved);
    return saved;
  }

  function closeVisit(entry: VisitRecord, actor: SampleClinicalActor, body: Body, terminated: boolean) {
    const reason = input(body.reason);
    if (terminated && !reason) fail(400, "EVIDENCE_REQUIRED", "请填写中止原因。");
    if (!terminated && !entry.items.length) fail(409, "EVIDENCE_REQUIRED", "正常完成至少须保存一项实际治疗。");
    entry.status = terminated ? "TERMINATED" : "COMPLETED";
    entry.endedAt = actionTime(entry.row);
    entry.notes = input(body.clinical_notes);
    entry.reason = terminated ? reason : undefined;
    entry.row.status = "done";
    assignments.delete(entry.row.id);
    return projectVisit(entry, actor);
  }

  function requestAppointment(row: Fixture, action: string, method: string, body: Body, actor: SampleClinicalActor) {
    const front = action === "chair-options" || action === "check-in" || action === "assign-chair";
    actor.authorize(front ? frontDesk : dentistRole, row.clinic);
    if (!front && !isOwner(row, actor)) fail(404, "NOT_FOUND", "找不到本人负责的预约。");
    const booking = appointment(row, actor);
    if (action === "clinical-context") {
      requireMethod(method, "GET");
      return context(row, booking, actor);
    }
    if (action === "chair-options") {
      requireMethod(method, "GET");
      return {items:availableChairs(row, booking),next_cursor:null};
    }
    requireMethod(method, "POST");
    verifyClaim(booking, body);
    if (action === "allergy-reviews") return saveReview(row, booking, body);
    if (action === "start-visit") return startVisit(row, booking, actor);
    if (action === "check-in") {
      if (row.status !== "arrived") {
        if (row.status !== "booked" || booking.deposit?.status !== "PAID") {
          fail(409, "INVALID_TRANSITION", "只有有效预约可签到。");
        }
        if (body.identity_confirmed !== true) fail(400, "EVIDENCE_REQUIRED", "请先核对到诊者身份。");
        row.status = "arrived";
        checkIns.set(row.id, actionTime(row));
      }
      return {...appointment(row, actor),check_in_at:checkInAt(row.id)};
    }
    const chair = availableChairs(row, booking).find(option => option.chair_id === String(body.chair_id));
    if (!chair) fail(409, "RESOURCE_CONFLICT", "牙椅不能在所需区间分配，签到状态保持。");
    assignments.set(row.id, chair.chair_id);
    knownChairs.add(chair.chair_id);
    return {appointment_id:booking.appointment_id,status:booking.status,...chair,assigned_at:actionTime(row)};
  }

  function requestVisit(entry: VisitRecord, action: string | undefined, method: string, body: Body, actor: SampleClinicalActor) {
    const owner = isOwner(entry.row, actor);
    if (!action) {
      requireMethod(method, "GET");
      if (!owner) actor.authorize(frontDesk, entry.row.clinic);
      const summary = projectVisit(entry, actor);
      const can_issue_invoice = entry.status !== "IN_PROGRESS" && actor.allowed(frontDesk, entry.row.clinic);
      if (owner) return {...summary,can_issue_invoice};
      const {visit_id, appointment_id, appointment_no, status, started_at, ended_at, chair, treatment_items, estimated_amount, refund} = summary;
      return {visit_id,appointment_id,appointment_no,status,started_at,ended_at,chair,treatment_items,estimated_amount,refund,can_issue_invoice};
    }
    requireMethod(method, "POST");
    actor.authorize(dentistRole, entry.row.clinic);
    if (!owner) fail(404, "NOT_FOUND", "找不到本人负责的诊疗。");
    if (entry.status !== "IN_PROGRESS") fail(409, "INVALID_TRANSITION", "只有正在进行的诊疗可更新。");
    if (action === "additional-decisions") return decision(entry, body);
    if (action === "treatment-items") return saveTreatment(entry, appointment(entry.row, actor), body);
    return closeVisit(entry, actor, body, action === "terminate");
  }

  function dispatch(route: string, q: URLSearchParams, method: string, body: Body, actor: SampleClinicalActor): unknown {
    if (route === "/clinical/materials") {
      requireMethod(method, "GET");
      actor.authorize(dentistRole);
      return {items:materialsFor(q.get("date") ?? clockDate).map(material => ({material_id:material.material_id,material_name:material.material_name,
        standard_unit:material.standard_unit,cost_references:[material.reference]})),next_cursor:null};
    }
    if (route === "/clinical/queue") {
      requireMethod(method, "GET");
      const clinic = q.get("clinic_id");
      actor.authorize(dentistRole, clinic ?? undefined);
      const owned = appointments.filter(row => (!clinic || row.clinic === clinic) && isOwner(row, actor));
      const history = q.get("view") === "history";
      const items = (history ? owned.filter(row => visitsByAppointment.get(row.id)?.endedAt) : owned.filter(needsChair))
        .map(row => {
          const entry = visitsByAppointment.get(row.id);
          return {...appointment(row, actor),chair:chairForAppointment(row.id),visit_id:entry?.id ?? null,
            check_in_at:checkInAt(row.id),ended_at:entry?.endedAt,visit_status:entry?.status};
        });
      if (history) return {items:items.sort((left, right) => Date.parse(right.ended_at!) - Date.parse(left.ended_at!)).slice(0, 100),next_cursor:null};
      return {items:items.sort((left, right) => Date.parse(left.start_at) - Date.parse(right.start_at)),next_cursor:null};
    }
    const bookingRoute = route.match(/^\/appointments\/([^/]+)\/(clinical-context|allergy-reviews|check-in|chair-options|assign-chair|start-visit)$/);
    if (bookingRoute) {
      const row = appointments.find(entry => entry.id === bookingRoute[1]);
      if (!row) fail(404, "NOT_FOUND", "找不到对应预约。");
      return requestAppointment(row, bookingRoute[2], method, body, actor);
    }
    const visitRoute = route.match(/^\/visits\/([^/]+)(?:\/(treatment-items|additional-decisions|finish|terminate))?$/);
    if (visitRoute) {
      actor.authorize(clinicalRoles);
      const entry = visits.get(visitRoute[1]) ?? visitsByAppointment.get(visitRoute[1]);
      if (!entry) fail(404, "NOT_FOUND", "找不到对应诊疗。");
      return requestVisit(entry, visitRoute[2], method, body, actor);
    }
    return undefined;
  }

  return {dispatch,visit,visitForAppointment,visitIdForAppointment,chairForAppointment,refundForAppointment,checkInAt,
    hasChairHistory:(chairId:string)=>knownChairs.has(chairId),
    chairInUse:(chairId:string)=>appointments.some(row=>needsChair(row) && assignments.get(row.id)===chairId)};
}
