import { FormEvent, useEffect, useRef, useState } from "react";

import type { StaffIdentity } from "../../shared/AppShell";
import { ApiError, request } from "../../shared/api";
import { AffectedAppointments } from "./ResourceImpactPanel";
import type { Demand } from "./ShiftDemandForm";
import { addDays, AppointmentSummary, Dentist, localDate, localTime, Shift, shiftLabels, toOffset } from "./types";

type Context = { identity: StaffIdentity; clinicId: string; onAppointment?: (id: string, start: string) => void };

function weekStart() {
  const query = new URLSearchParams(window.location.search).get("week");
  if (query && /^\d{4}-\d{2}-\d{2}$/.test(query) && !Number.isNaN(Date.parse(query))) return query;
  const today = localDate(new Date());
  const day = new Date(today + "T00:00:00Z").getUTCDay();
  return addDays(today, -((day + 6) % 7));
}

function currentLocalTime(value?: string) {
  return value ? localDate(value) + "T" + localTime(value) : "";
}

function ShiftEditor({
  identity, clinicId, dentists, shift, onSave,
}: Context & { dentists: Dentist[]; shift?: Shift; onSave: (shift: Shift) => void }) {
  const [demands, setDemands] = useState<Demand[]>([]);
  const [clinic, setClinic] = useState(shift?.clinic_id || clinicId || identity.clinics[0]?.clinic_id || "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    if (clinic) {
      request<{ items: Demand[] }>("/shift-demands?clinic_id=" + encodeURIComponent(clinic), { signal: controller.signal })
        .then(result => setDemands(result.items)).catch(failure => {
          if (!controller.signal.aborted) setError(failure.message);
        });
    }
    return () => controller.abort();
  }, [clinic]);

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
      const saved = await request<Shift>(shift ? "/shifts/" + shift.shift_id : "/shifts", {
        method: shift ? "PATCH" : "POST", actionKey: crypto.randomUUID(), body,
      });
      onSave(saved);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存班次。");
    } finally {
      setPending(false);
    }
  }

  return <form className="schedule-form" onSubmit={save}>
    <label>门店<select value={clinic} onChange={event => setClinic(event.target.value)} required>
      {identity.clinics.map(item => <option value={item.clinic_id} key={item.clinic_id}>{item.name}</option>)}
    </select></label>
    <label>牙医<select name="dentist_id" defaultValue={shift?.dentist_id} required>
      {dentists.map(person => <option key={person.dentist_id} value={person.dentist_id}>{person.name}</option>)}
    </select></label>
    <label>关联需求<select name="demand_id" defaultValue={shift?.demand_id || ""} key={clinic}>
      <option value="">无关联需求</option>
      {demands.map(item => <option key={item.demand_id} value={item.demand_id}>
        {localDate(item.start_at)} {localTime(item.start_at)}–{localTime(item.end_at)} · {item.required_count} 人
      </option>)}
    </select></label>
    <label>开始<input name="start_at" type="datetime-local" defaultValue={currentLocalTime(shift?.start_at)} required /></label>
    <label>结束<input name="end_at" type="datetime-local" defaultValue={currentLocalTime(shift?.end_at)} required /></label>
    {shift && <label>调整原因<input name="reason" required /></label>}
    <button className="button primary" disabled={pending || !dentists.length}>{shift ? "保存调整" : "保存草案"}</button>
    {error && <p className="error-text" role="alert">{error}</p>}
  </form>;
}

function ShiftDetails({ shift, identity, clinicId, dentists, onUpdate, onClose, onAppointment }: Context & {
  shift: Shift;
  dentists: Dentist[];
  onUpdate: (shift: Shift) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [affected, setAffected] = useState<AppointmentSummary[]>();
  const [pending, setPending] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const scheduler = identity.capabilities.includes("HQ_SCHEDULER");
  const dentist = identity.capabilities.includes("DENTIST") && identity.employee_id === shift.dentist_id;
  const canCoordinate = scheduler || identity.capabilities.includes("CLINIC_MANAGER");
  const doctor = dentists.find(item => item.dentist_id === shift.dentist_id);

  useEffect(() => { close.current?.focus(); }, []);

  async function action(endpoint: string, body: Record<string, unknown> = {}) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const saved = await request<Shift>("/shifts/" + shift.shift_id + "/" + endpoint, {
        method: "POST", actionKey: crypto.randomUUID(), body,
      });
      onUpdate(saved);
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
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法读取受影响预约。");
    }
  }

  return <aside className="schedule-drawer" aria-labelledby="shift-detail-title" onKeyDown={event => {
    if (event.key === "Escape") onClose();
  }}>
    <div className="schedule-heading">
      <h2 id="shift-detail-title">班次详情</h2>
      <button className="button" ref={close} onClick={onClose}>关闭</button>
    </div>
    <p>{identity.clinics.find(c => c.clinic_id === shift.clinic_id)?.name} · {doctor?.name || "本人"}</p>
    <p>{localDate(shift.start_at)} {localTime(shift.start_at)}–{localTime(shift.end_at)}</p>
    <span className="status-tag" data-state={shift.status}>{shiftLabels[shift.status] || shift.status}</span>
    {doctor?.qualifications.length ? <ul className="compact-list">
      {doctor.qualifications.map(qualification => <li key={qualification.qualification_id}>
        <strong>{qualification.name}</strong>
        <span>{qualification.valid_from || "无起始限制"} 至 {qualification.valid_until || "无截止限制"}</span>
      </li>)}
    </ul> : null}
    {scheduler && (shift.status === "DRAFT" || shift.status === "REJECTED") && <ShiftEditor
      key={shift.status + ":" + shift.shift_id} identity={identity} clinicId={clinicId}
      dentists={dentists} shift={shift} onSave={onUpdate}
    />}
    {scheduler && shift.status === "DRAFT" &&
      <button className="button primary" disabled={pending} onClick={() => action("submit")}>提交牙医确认</button>}
    {dentist && shift.status === "PENDING" && <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      action("respond", { decision: data.get("decision"), reason: data.get("reason") });
    }}>
      <label>答复<select name="decision"><option value="ACCEPTED">接受</option><option value="REJECTED">拒绝</option></select></label>
      <label>原因<input name="reason" placeholder="拒绝时必填" /></label>
      <button className="button primary" disabled={pending}>提交答复</button>
    </form>}
    {scheduler && shift.status === "ACCEPTED" && <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const verified = fields.get("route_feasible") === "on";
      action("publish", verified ? { route_feasible: true, evidence_ref: fields.get("evidence_ref") } : {});
    }}>
      <label className="inline-control"><input type="checkbox" name="route_feasible" />已与牙医核对跨店路线可行</label>
      <label>路线核验依据<input name="evidence_ref" /></label>
      <button className="button primary" disabled={pending}>复查并发布</button>
    </form>}
    {canCoordinate && shift.status === "PUBLISHED" &&
      <button className="button" onClick={showAffected}>查看受影响预约</button>}
    {scheduler && shift.status === "PUBLISHED" && <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      action("withdraw", { reason: new FormData(event.currentTarget).get("reason") });
    }}>
      <label>停诊原因<input name="reason" required /></label>
      <button className="button" disabled={pending}>撤销班次</button>
    </form>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {affected && <AffectedAppointments items={affected} onAppointment={onAppointment} />}
  </aside>;
}

export function ShiftBoard({ identity, clinicId, onAppointment }: Context) {
  const [week, setWeek] = useState(weekStart);
  const [listView, setListView] = useState(false);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [dentists, setDentists] = useState<Dentist[]>([]);
  const [selected, setSelected] = useState<Shift>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const origin = useRef<HTMLButtonElement | null>(null);
  const scheduler = identity.capabilities.includes("HQ_SCHEDULER");
  const directory = scheduler || identity.capabilities.includes("CLINIC_MANAGER");
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));

  useEffect(() => {
    const params = new URLSearchParams({ date_from: week, date_to: addDays(week, 6), view: "week" });
    if (clinicId) params.set("clinic_id", clinicId);
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      request<{ shifts: Shift[] }>("/schedule/board?" + params.toString(), { signal: controller.signal }),
      directory
        ? request<{ items: Dentist[] }>("/schedule/dentists", { signal: controller.signal })
        : Promise.resolve({ items: [] }),
    ]).then(([board, people]) => {
      setShifts(board.shifts);
      setDentists(people.items);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message || "无法读取周排班。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [week, clinicId, directory]);

  function go(date: string) {
    const query = new URLSearchParams(window.location.search);
    query.set("week", date);
    window.history.replaceState({}, "", window.location.pathname + "?" + query.toString());
    setSelected(undefined);
    setWeek(date);
  }

  function open(shift: Shift, button: HTMLButtonElement) {
    origin.current = button;
    setSelected(shift);
  }

  function close() {
    setSelected(undefined);
    origin.current?.focus();
  }

  function updated(shift: Shift) {
    setShifts(old => [...old.filter(item => item.shift_id !== shift.shift_id), shift]);
    setSelected(shift);
    setCreating(false);
  }

  const activeDentists = [...new Set(dentists.map(doctor => doctor.dentist_id).concat(shifts.map(shift => shift.dentist_id)))];
  const name = (id: string) => dentists.find(item => item.dentist_id === id)?.name || (identity.employee_id === id ? "本人" : "牙医 " + id);
  const clinicName = (id: string) => identity.clinics.find(item => item.clinic_id === id)?.name || "门店 " + id;
  const button = (shift: Shift) => <button type="button" className="shift-slot" key={shift.shift_id}
    onClick={evt => open(shift, evt.currentTarget)}>
    <span>{localTime(shift.start_at)}–{localTime(shift.end_at)}</span>
    <strong>{clinicName(shift.clinic_id)}</strong>
    <small className="status-tag" data-state={shift.status}>{shiftLabels[shift.status] || shift.status}</small>
  </button>;

  return <section className="schedule-panel">
    <div className="schedule-heading">
      <h2>跨店排班</h2>
      <div className="schedule-toolbar">
        <button className="button" onClick={() => go(addDays(week, -7))}>上一周</button>
        <label>周起始日期 <input aria-label="周起始日期" type="date" value={week} onChange={event => event.target.value && go(event.target.value)} /></label>
        <button className="button" onClick={() => go(addDays(week, 7))}>下一周</button>
        <button className="button" onClick={() => setListView(value => !value)}>{listView ? "周视图" : "列表"}</button>
        {scheduler && <button className="button primary" onClick={() => setCreating(value => !value)}>拟排班次</button>}
      </div>
    </div>
    {creating && <ShiftEditor identity={identity} clinicId={clinicId} dentists={dentists} onSave={updated} />}
    {error && <p role="alert" className="error-text">{error}</p>}
    {loading ? <p className="muted">正在读取周排班…</p> : listView ? (
      <ul className="compact-list">{shifts.map(shift => <li key={shift.shift_id}>
        <strong>{name(shift.dentist_id)}</strong><span>{localDate(shift.start_at)}</span>{button(shift)}
      </li>)}</ul>
    ) : <div className="schedule-scroll">
      <table className="shift-grid">
        <thead><tr><th scope="col">牙医</th>{days.map(day => <th scope="col" key={day}>{day.slice(5)}</th>)}</tr></thead>
        <tbody>
          {activeDentists.map(id => <tr key={id}>
            <th scope="row">{name(id)}</th>
            {days.map(day => <td key={day}>{shifts.filter(shift =>
              shift.dentist_id === id && localDate(shift.start_at) === day).map(button)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>}
    {!loading && !error && !shifts.length && <p className="muted">本周没有可见班次。</p>}
    {selected && <ShiftDetails key={selected.shift_id} shift={selected} dentists={dentists} clinicId={clinicId}
      identity={identity} onClose={close} onUpdate={updated} onAppointment={onAppointment} />}
  </section>;
}
