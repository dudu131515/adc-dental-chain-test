import type { Patient } from "../src/features/schedule/BookingForm";
import type { Appointment as AppointmentView, Candidate, Chair, FundsStatus } from "../src/features/schedule/appointmentTypes";
import { localDate, localTime } from "../src/features/schedule/types";
import type { Visit } from "../src/features/clinical/clinicalTypes";
import type { StaffIdentity } from "../src/shared/navigation";
import { ApiError } from "../src/shared/api";
import type { Appointment } from "./fixtures";

export const coordinatorRoles = ["FRONT_DESK", "CLINIC_MANAGER", "HQ_SCHEDULER"];
export const appointmentStates = {
  booked: "CONFIRMED", arrived: "CHECKED_IN", treating: "IN_TREATMENT",
  done: "COMPLETED", missed: "NO_SHOW", cancelled: "CANCELLED",
} as const;
export const at = (date: string, time: string) => date + "T" + time + ":00+08:00";
export const appointmentStart = (row: Appointment) => at(row.date, row.time);
export const appointmentEnd = (row: Appointment) =>
  new Date(Date.parse(appointmentStart(row)) + (row.minutes ?? 30) * 60_000).toISOString();

export type SampleActor = {
  allowed(roles: string[], clinic?: string): boolean;
  authorize(roles: string[], clinic?: string): void;
  dentist(): string;
};
type Treatment = { treatment_type_id: string; treatment_name: string };
type Evidence = { appointment_no: string; origin_clinic_id: string; old_start_at: string; old_end_at: string; changed_at: string; reason: string };
type Seed = {
  appointments: Appointment[];
  branches: (StaffIdentity["clinics"][number] & {address: string})[];
  doctorId(row: Appointment): string;
  treatment(row: Appointment): Treatment | undefined;
  visit(id: string): Visit | undefined;
  visitId(id: string): string | undefined;
  chair(id: string): Chair | null;
  treatmentRefund(id: string): FundsStatus | undefined;
  billStatus(id: string): string;
  id(): string;
  clock: string;
};

function problem(status: number, message: string): never {
  throw new ApiError(status, {code: status === 404 ? "NOT_FOUND" : status === 403 ? "PERMISSION_DENIED" : "CONFLICT", message});
}
const hours = (ms: number) => ms / 3_600_000;
const field = (body: Record<string, unknown>, key: string) => String(body[key] ?? "");
const allDay = (row: Appointment, q: URLSearchParams) =>
  (!q.get("clinic_id") || row.clinic === q.get("clinic_id")) && (!q.get("date") || row.date === q.get("date"));

export function createSampleAppointments(seed: Seed) {
  const { appointments, branches, doctorId, treatment, visit, visitId, chair, treatmentRefund, billStatus, id, clock } = seed;
  const patientDirectory = new Map<string, Patient & { clinic: string }>();
  for (const row of appointments) {
    patientDirectory.set(row.clinic + ":" + row.patientId, {
      clinic: row.clinic, patient_id: row.patientId, full_name: row.patient,
      patient_no: "ADC-P" + row.patientId.padStart(4, "0"),
      phone: "0000000" + row.patientId.padStart(4, "0"), birth_date: "1998-06-01",
    });
  }
  const claims = new Map<string, string>();
  const deposits = new Map<string, NonNullable<AppointmentView["deposit"]>>();
  const refunds = new Map<string, FundsStatus>();
  const handovers = new Map<string, Evidence[]>();
  const now = Date.parse(clock);
  const coordinators = (actor: SampleActor, row: Appointment) => actor.allowed(coordinatorRoles, row.clinic);
  const front = (actor: SampleActor, row: Appointment) => actor.allowed(["FRONT_DESK"], row.clinic);
  const own = (actor: SampleActor, row: Appointment) =>
    actor.allowed(["DENTIST"], row.clinic) && actor.dentist() === doctorId(row);
  const visible = (actor: SampleActor, row: Appointment) => coordinators(actor, row) || own(actor, row);
  const claim = (row: Appointment) => claims.get(row.id) ?? row.id;
  const deposit = (row: Appointment) => deposits.get(row.id) ?? {deposit_id: row.id, amount:"50.00", status:"PAID"};

  function projection(row: Appointment, actor?: SampleActor): AppointmentView {
    const start = appointmentStart(row);
    const canFront = !actor || front(actor, row);
    const canIdentify = !actor || canFront || own(actor, row);
    const coordinator = !actor || coordinators(actor, row);
    const earlier = now < Date.parse(start);
    const state = appointmentStates[row.status];
    const actions: string[] = [];
    if (state === "CONFIRMED") {
      if (canFront) {
        actions.push("check_in");
        if (earlier) actions.push("reschedule", "cancel");
        if (now >= Date.parse(appointmentEnd(row))) actions.push("review_no_show");
      }
      if (coordinator) {
        actions.push("coordinate");
        if (!earlier) actions.push("cancellation_review");
      }
    } else if (state === "CHECKED_IN" && coordinator) actions.push("coordinate", "cancellation_review");
    return {
      appointment_id: row.id, appointment_no: row.id, claim_id: claim(row), status: state,
      is_attended: row.status === "done" || row.status === "treating",
      clinic: {clinic_id:row.clinic, name:branches.find(branch => branch.clinic_id === row.clinic)?.name ?? row.clinic,
        address:branches.find(branch => branch.clinic_id === row.clinic)?.address ?? ""},
      dentist: {dentist_id:doctorId(row), name:row.doctor},
      treatment: {treatment_type_id:treatment(row)?.treatment_type_id ?? row.treatmentId ?? "1", name:treatment(row)?.treatment_name ?? row.service},
      start_at:start, end_at:appointmentEnd(row), allowed_actions:actions,
      ...(canIdentify ? {patient_display:{patient_id:row.patientId, name:row.patient}, chair:chair(row.id), visit_id:visitId(row.id) ?? null} : {}),
      ...(canFront ? {deposit:deposit(row), refund:refunds.get(row.id) ?? treatmentRefund(row.id)} : {}),
    };
  }
  function rows(q: URLSearchParams, actor: SampleActor) {
    return appointments.filter(row => allDay(row,q) && visible(actor,row)
      && (!q.get("dentist_id") || doctorId(row) === q.get("dentist_id"))
      && (!q.get("status") || appointmentStates[row.status] === q.get("status")))
      .sort((a,b) => appointmentStart(a).localeCompare(appointmentStart(b)));
  }
  function page(q: URLSearchParams, total: number) {
    return {page:Math.max(1, Number(q.get("page")) || 1), page_size:20, total};
  }
  function patient(clinic: string, patientId: string) {
    return patientDirectory.get(clinic + ":" + patientId);
  }
  function queryPatients(clinic: string, search: string) {
    const q = search.trim().toLowerCase();
    return [...patientDirectory.values()].filter(p => p.clinic === clinic && (!q
      || p.full_name.toLowerCase().includes(q) || p.phone === q || p.patient_no.toLowerCase() === q));
  }

  function dispatchPatients(route: string, q: URLSearchParams, read: boolean, b: Record<string, unknown>, actor: SampleActor) {
    const match = route.match(/^\/clinics\/([^/]+)\/(patients|patient-directory)(?:\/(\d+))?$/);
    if (!match) return undefined;
    const [, clinic, collection, patientId] = match;
    actor.authorize(["FRONT_DESK"], clinic);
    if (patientId) {
      const person = patient(clinic, patientId);
      if (!person) problem(404, "找不到本门店的患者档案。");
      const history = appointments.filter(row => row.patientId === patientId && row.clinic === clinic)
        .sort((a,b) => appointmentStart(b).localeCompare(appointmentStart(a)));
      const info = page(q, history.length);
      const offset = (info.page - 1) * info.page_size;
      return {patient:person,...info, appointments:history.slice(offset, offset + info.page_size).map(row => {
        const outcome = visit(row.id);
        return {appointment_id:row.id, appointment_no:row.id, start_at:appointmentStart(row), treatment:row.service,
          dentist:row.doctor, status:appointmentStates[row.status],
          ...(outcome ? {visit:{visit_id:outcome.visit_id,status:outcome.status}} : {}),
          ...(row.invoice ? {invoice:{invoice_id:row.invoice,invoice_no:row.invoice,status:billStatus(row.invoice)}} : {})};
      })};
    }
    if (read) {
      const items = queryPatients(clinic, q.get("q") ?? "").map(person => ({...person, next_start:
        appointments.filter(row => row.clinic === clinic && row.patientId === person.patient_id && row.status === "booked")
          .map(appointmentStart).filter(start => Date.parse(start) >= now).sort()[0] ?? null}));
      if (collection !== "patient-directory") return {items};
      const info = page(q,items.length);
      const offset = (info.page - 1) * info.page_size;
      return {...info, items:items.slice(offset, offset + info.page_size)};
    }
    const person = {clinic, patient_id:id(), patient_no:"", full_name:field(b,"full_name"),
      birth_date:field(b,"birth_date"), phone:field(b,"phone")};
    if (!person.full_name || !person.birth_date || !person.phone) problem(400, "请填写患者姓名、出生日期和电话。");
    person.patient_no = "ADC-PREVIEW-" + person.patient_id;
    patientDirectory.set(clinic + ":" + person.patient_id, person);
    return person;
  }

  function refundAmount(row: Appointment, cause: string) {
    if (cause === "CLINIC") return deposit(row).amount;
    const advance = hours(Date.parse(appointmentStart(row)) - now);
    return (Number(deposit(row).amount) * (advance >= 24 ? 1 : advance >= 2 ? .5 : 0)).toFixed(2);
  }
  function rememberChange(row: Appointment, reason: string) {
    const previous = handovers.get(row.id) ?? [];
    previous.push({appointment_no:row.id, origin_clinic_id:row.clinic, old_start_at:appointmentStart(row),
      old_end_at:appointmentEnd(row), changed_at:clock, reason});
    handovers.set(row.id, previous);
  }
  function dispatchAppointment(route: string, q: URLSearchParams, read: boolean, b: Record<string, unknown>,
    actor: SampleActor, candidates: (q: URLSearchParams) => Candidate[]) {
    if (route === "/appointments") return {items:rows(q,actor).map(row => projection(row,actor))};
    const match = route.match(/^\/appointments\/([^/]+)(?:\/(reschedule|cancel|no-show|cancellation-quote|cancellation-review|coordination-intents|handover-evidence))?$/);
    if (!match) {
      const refund = route.match(/^\/deposit-refunds\/([^/]+)(?:\/retry)?$/);
      if (!refund) return undefined;
      const row = appointments.find(item => (refunds.get(item.id) ?? treatmentRefund(item.id))?.refund_id === refund[1]);
      if (!row || !front(actor,row)) problem(404,"找不到本店退金记录。");
      return refunds.get(row.id) ?? treatmentRefund(row.id);
    }
    const [, recordId, action] = match;
    const row = appointments.find(item => item.id === recordId);
    if (action === "handover-evidence") {
      return {items:(handovers.get(recordId) ?? []).filter(entry => actor.allowed(coordinatorRoles,entry.origin_clinic_id))};
    }
    if (!row || !visible(actor,row)) problem(404, "找不到可访问的预约。");
    const current = projection(row,actor);
    if (!action) return current;
    const cause = (read ? q.get("cause") : b.cause) === "CLINIC" ? "CLINIC" : "PATIENT";
    const allowed = current.allowed_actions;
    const canCancel = cause === "CLINIC" ? allowed.includes("coordinate") && !allowed.includes("cancellation_review") : allowed.includes("cancel");
    if (action === "cancellation-quote") {
      if (!canCancel) problem(409,"当前预约需要核实后办理。");
      return {expected_claim_id:claim(row),refund_amount:refundAmount(row,cause),cause};
    }
    if (claim(row) !== field(b,"expected_claim_id")) problem(409,"预约已变更，请重新查询。");
    const reason = field(b,"reason");
    if (action === "coordination-intents" && allowed.includes("coordinate")) {
      rememberChange(row, field(b,"impact"));
      return {evidence_id:id()};
    }
    if (action === "reschedule") {
      if (!allowed.includes(cause === "CLINIC" ? "coordinate" : "reschedule") || row.status !== "booked")
        problem(409,"当前预约不可改期。");
      const clinic = field(b,"clinic_id");
      actor.authorize(cause === "CLINIC" ? coordinatorRoles : ["FRONT_DESK"],clinic);
      if (cause === "CLINIC" && !field(b,"patient_consent_ref")) problem(400,"请提供患者同意的凭据。");
      const incoming = field(b,"start_at"), date = localDate(incoming);
      const options = new URLSearchParams({clinic_id:clinic,date,appointment_id:recordId,
        dentist_id:field(b,"dentist_id"),treatment_type_id:current.treatment.treatment_type_id,preferred_start_at:incoming});
      const slot = candidates(options).find(item => item.shift_id === field(b,"shift_id") && Date.parse(item.end_at) === Date.parse(field(b,"end_at")));
      if (!slot) problem(409,"目标时段已不可用，请重新选择。");
      rememberChange(row,reason);
      const previousPatient = patient(row.clinic,row.patientId);
      row.clinic = slot.clinic_id; row.doctor = slot.dentist_name; row.dentistId = slot.dentist_id; row.date = date;
      row.time = localTime(slot.start_at); row.minutes = (Date.parse(slot.end_at)-Date.parse(slot.start_at))/60_000;
      claims.set(row.id,id());
      if (previousPatient && !patient(row.clinic,row.patientId)) patientDirectory.set(row.clinic+":"+row.patientId,{...previousPatient,clinic:row.clinic});
      return projection(row,actor);
    }
    if (action === "no-show" && allowed.includes("review_no_show")) {
      if (!b.patient_absent || !b.clinic_able) problem(400,"请核实患者未到且诊所可履约。");
      row.status = "missed";
      return projection(row,actor);
    }
    if ((action === "cancel" && canCancel) || (action === "cancellation-review" && allowed.includes("cancellation_review"))) {
      if (action === "cancellation-review" && b.conclusion === "CONTINUE") return current;
      const actualCause = b.conclusion === "CLINIC_CANCEL" ? "CLINIC" : cause;
      const amount = refundAmount(row,actualCause);
      if (action === "cancel" && Number(b.quoted_refund_amount) !== Number(amount)) problem(409,"退金金额已更新，请重新核对。");
      if (actualCause === "CLINIC" && !b.coordination_evidence && !handovers.get(row.id)?.some(item => item.origin_clinic_id === row.clinic))
        problem(400,"请提供本店协调依据。");
      row.status = "cancelled";
      if (Number(amount)) refunds.set(row.id,{refund_id:id(),amount,status:"SUCCEEDED"});
      return projection(row,actor);
    }
    problem(409,"当前状态无法办理该项操作。");
  }
  return {projection, rows, patient, dispatchPatients, dispatchAppointment,
    establishDeposit(appointmentId: string, claimId: string, payment: NonNullable<AppointmentView["deposit"]>) {
      claims.set(appointmentId,claimId); deposits.set(appointmentId,payment);
    }};
}
