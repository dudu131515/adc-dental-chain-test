import { FormEvent, useEffect, useRef, useState } from "react";

import type { StaffIdentity } from "../../shared/AppShell";
import { useApiRequest } from "../../shared/ApiTransport";
import { ApiError } from "../../shared/api";
import { canWorkAt } from "../../shared/navigation";
import { AffectedAppointments } from "./ResourceImpactPanel";
import type { Demand } from "./ShiftDemandForm";
import { BoardDentist, BoardShift, ClinicOption, DraftContext, RunBatch, dentistsAt } from "./shiftBoardTypes";
import { addDays, AppointmentSummary, localDate, localTime, shiftLabels, toOffset } from "./types";

type EditorProps = {
  clinics: ClinicOption[];
  dentists: BoardDentist[];
  draft: DraftContext;
  shift?: BoardShift;
  onSave: (shift: BoardShift) => void;
};

function inputTime(value: string) {
  return localDate(value) + "T" + localTime(value);
}

export function ShiftEditor({ clinics, dentists, draft, shift, onSave }: EditorProps) {
  const request = useApiRequest();
  const [demands, setDemands] = useState<Demand[]>([]);
  const initial = shift?.clinic_id ?? draft.clinicId;
  const [clinic, setClinic] = useState(clinics.find(row => row.clinic_id === initial)?.clinic_id || clinics[0]?.clinic_id || "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const assigned = dentistsAt(dentists, clinic);
  const preferred = shift?.dentist_id ?? draft.dentistId;
  const defaultDentist = assigned.find(row => row.dentist_id === preferred)?.dentist_id ?? assigned[0]?.dentist_id ?? "";

  useEffect(() => {
    const controller = new AbortController();
    if (clinic) {
      request<{ items: Demand[] }>("/shift-demands?clinic_id=" + encodeURIComponent(clinic), { signal: controller.signal })
        .then(result => setDemands(result.items)).catch(failure => {
          if (!controller.signal.aborted) setError(failure.message);
        });
    }
    return () => controller.abort();
  }, [clinic, request]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    const body = {
      clinic_id: clinic, dentist_id: fields.get("dentist_id"),
      demand_id: fields.get("demand_id") || null,
      start_at: toOffset(fields.get("start_at")), end_at: toOffset(fields.get("end_at")),
      ...(shift ? { expected_status: shift.status, reason: fields.get("reason") } : {}),
    };
    try {
      const result = await request<BoardShift>(shift ? "/shifts/" + shift.shift_id : "/shifts", {
        method: shift ? "PATCH" : "POST", actionKey: crypto.randomUUID(), body,
      });
      onSave(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存班次。");
    } finally {
      setPending(false);
    }
  }

  const start = shift?.start_at ?? draft.demand?.start_at;
  const end = shift?.end_at ?? draft.demand?.end_at;
  const requestedDemand = clinic === initial ? shift?.demand_id ?? draft.demand?.demand_id : "";
  const options = demands.filter(row => row.clinic_id === clinic);
  const selectedDemand = options.find(row => row.demand_id === requestedDemand);
  const demandOptions = options.length || !draft.demand || draft.demand.clinic_id !== clinic ? options : [draft.demand];

  return <form className="schedule-form" aria-label={shift ? "调整班次" : "拟排班次"} onSubmit={save}>
    <label>门店<select value={clinic} onChange={event => setClinic(event.target.value)} required>
      {clinics.map(item => <option value={item.clinic_id} key={item.clinic_id}>{item.name}</option>)}
    </select></label>
    <label>牙医<select name="dentist_id" defaultValue={defaultDentist} key={clinic} required>
      <option value="">选择牙医</option>
      {assigned.map(person => <option key={person.dentist_id} value={person.dentist_id}>{person.name}</option>)}
    </select></label>
    <label>关联需求<select name="demand_id" defaultValue={requestedDemand || ""} key={clinic + ":" + (selectedDemand?.demand_id || "")}>
      <option value="">无关联需求</option>
      {demandOptions.map(item => <option key={item.demand_id} value={item.demand_id}>
        {localDate(item.start_at)} {localTime(item.start_at)}–{localTime(item.end_at)} · {item.required_count} 人
      </option>)}
    </select></label>
    <label>开始<input name="start_at" type="datetime-local" defaultValue={start ? inputTime(start) : draft.day + "T09:00"} required /></label>
    <label>结束<input name="end_at" type="datetime-local" defaultValue={end ? inputTime(end) : draft.day + "T12:00"} required /></label>
    {shift && <label>调整原因<input name="reason" required /></label>}
    <button className="button primary" disabled={pending || !assigned.length}>{shift ? "保存调整" : "保存草案"}</button>
    {error && <p className="error-text" role="alert">{error}</p>}
  </form>;
}

type DetailProps = Omit<EditorProps, "draft" | "shift"> & {
  identity: StaffIdentity;
  shift: BoardShift;
  canCopy: boolean;
  batchPending: boolean;
  runBatch: RunBatch;
  onClose: () => void;
  onAppointment?: (id: string, start: string) => void;
};

export function ShiftDetails({
  shift, identity, dentists, clinics, onSave, onClose, onAppointment, canCopy, batchPending, runBatch,
}: DetailProps) {
  const request = useApiRequest();
  const [error, setError] = useState("");
  const [affected, setAffected] = useState<AppointmentSummary[]>();
  const [pending, setPending] = useState(false);
  const [copying, setCopying] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const scheduler = canWorkAt(identity, "HQ_SCHEDULER", shift.clinic_id);
  const dentist = canWorkAt(identity, "DENTIST", shift.clinic_id) && identity.employee_id === shift.dentist_id;
  const canCoordinate = scheduler || canWorkAt(identity, "CLINIC_MANAGER", shift.clinic_id);
  const doctor = dentists.find(item => item.dentist_id === shift.dentist_id);
  const date = localDate(shift.start_at);

  useEffect(() => { close.current?.focus(); }, []);

  async function action(endpoint: string, body: Record<string, unknown> = {}) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const saved = await request<BoardShift>("/shifts/" + shift.shift_id + "/" + endpoint, {
        method: "POST", actionKey: crypto.randomUUID(), body,
      });
      onSave({ ...shift, ...saved });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法办理班次。");
      if (failure instanceof ApiError && Array.isArray(failure.error.details?.appointments)) {
        setAffected(failure.error.details.appointments as AppointmentSummary[]);
      }
    } finally {
      setPending(false);
    }
  }

  async function showAffected() {
    try {
      const result = await request<{ items: AppointmentSummary[] }>("/shifts/" + shift.shift_id + "/affected-appointments");
      setAffected(result.items);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法读取受影响预约。");
    }
  }

  return <aside className="schedule-drawer" aria-labelledby="shift-detail-title" onKeyDown={event => {
    if (event.key === "Escape") onClose();
  }}>
    <div className="schedule-heading">
      <h2 id="shift-detail-title">班次详情</h2>
      <button className="button" ref={close} onClick={onClose}>关闭</button>
    </div>
    <p>{shift.clinic_name || identity.clinics.find(c => c.clinic_id === shift.clinic_id)?.name} · {doctor?.name || shift.dentist_name || "本人"}</p>
    <p>{date} {localTime(shift.start_at)}–{localTime(shift.end_at)}</p>
    <span className="status-tag" data-state={shift.status}>{shiftLabels[shift.status] || shift.status}</span>
    {shift.rejection_reason && shift.status === "REJECTED" && <p className="shift-reason">{shift.rejection_reason}</p>}
    {doctor?.qualifications.length ? <ul className="compact-list">
      {doctor.qualifications.map(qualification => <li key={qualification.qualification_id}>
        <strong>{qualification.name}</strong>
        <span>{qualification.valid_from || "无起始限制"} 至 {qualification.valid_until || "无截止限制"}</span>
      </li>)}
    </ul> : null}
    {scheduler && clinics.length > 0 && (shift.status === "DRAFT" || shift.status === "REJECTED") && <ShiftEditor
      key={shift.status + ":" + shift.shift_id} clinics={clinics} dentists={dentists} shift={shift}
      draft={{ day: date }} onSave={onSave}
    />}
    {scheduler && shift.status === "DRAFT" &&
      <button className="button primary" disabled={pending || batchPending} onClick={() => void action("submit")}>提交牙医确认</button>}
    {dentist && shift.status === "PENDING" && <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void action("respond", { decision: data.get("decision"), reason: data.get("reason") });
    }}>
      <label>答复<select name="decision"><option value="ACCEPTED">接受</option><option value="REJECTED">拒绝</option></select></label>
      <label>原因<input name="reason" placeholder="拒绝时必填" /></label>
      <button className="button primary" disabled={pending}>提交答复</button>
    </form>}
    {scheduler && shift.status === "ACCEPTED" && <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const verified = fields.get("route_feasible") === "on";
      void action("publish", verified ? { route_feasible: true, evidence_ref: fields.get("evidence_ref") } : {});
    }}>
      <label className="inline-control"><input type="checkbox" name="route_feasible" />已与牙医核对跨店路线可行</label>
      <label>路线核验依据<input name="evidence_ref" /></label>
      <button className="button primary" disabled={pending || batchPending}>复查并发布</button>
    </form>}
    {canCopy && shift.status !== "CANCELLED" && <>
      <button className="button" type="button" aria-expanded={copying} onClick={() => setCopying(value => !value)}>复制班次</button>
      {copying && <form className="schedule-form" onSubmit={event => {
        event.preventDefault();
        const target_date = String(new FormData(event.currentTarget).get("target_date") || "");
        void runBatch({ action: "copy", source_shift_id: shift.shift_id, target_date }, () => setCopying(false));
      }}>
        <label>复制到<input type="date" name="target_date" defaultValue={addDays(date, 1)} required /></label>
        <button className="button primary" disabled={batchPending || pending}>复制为草案</button>
      </form>}
    </>}
    {canCoordinate && shift.status === "PUBLISHED" &&
      <button className="button" onClick={() => void showAffected()}>查看受影响预约</button>}
    {scheduler && shift.status === "PUBLISHED" && <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      void action("withdraw", { reason: new FormData(event.currentTarget).get("reason") });
    }}>
      <label>停诊原因<input name="reason" required /></label>
      <button className="button" disabled={pending}>撤销班次</button>
    </form>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {affected && <AffectedAppointments items={affected} onAppointment={onAppointment} />}
  </aside>;
}
