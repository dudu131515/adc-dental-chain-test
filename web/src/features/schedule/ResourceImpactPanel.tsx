import { FormEvent, useEffect, useState } from "react";

import { request } from "../../shared/api";
import type { StaffIdentity } from "../../shared/AppShell";
import { AppointmentSummary, localDate, localTime, toOffset } from "./types";

type Chair = {
  chair_id: string;
  chair_no: string;
  chair_kind: string;
  status: string;
  unavailability: { unavailability_id: string; start_at: string; end_at: string; reason?: string }[];
};

export function AffectedAppointments({ items, onAppointment }: {
  items: AppointmentSummary[]; onAppointment?: (id: string, start: string) => void;
}) {
  if (!items.length) return <p className="muted">当前没有待协调预约。</p>;
  return <ul className="compact-list">
    {items.map(item => <li key={item.appointment_id}>
      {onAppointment ? <button className="text-action" onClick={() => onAppointment(item.appointment_id, item.start_at)}>
        {item.appointment_no} · 协调预约
      </button> : <strong>{item.appointment_no}</strong>}
      <span>{localDate(item.start_at)} {localTime(item.start_at)}–{localTime(item.end_at)}</span>
      {item.same_clinic_options?.length ? <span>同店可选时段 {item.same_clinic_options.length} 个</span> : null}
    </li>)}
  </ul>;
}

export function ResourceImpactPanel({ identity, clinicId, onAppointment }: {
  identity: StaffIdentity; clinicId: string; onAppointment?: (id: string, start: string) => void;
}) {
  const [chosen, setChosen] = useState(clinicId || identity.clinics[0]?.clinic_id || "");
  const [chairs, setChairs] = useState<Chair[]>([]);
  const [impacted, setImpacted] = useState<AppointmentSummary[]>();
  const [update, setUpdate] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const readOnly = !identity.capabilities.includes("CLINIC_MANAGER");

  useEffect(() => {
    if (!chosen) return;
    const controller = new AbortController();
    request<{ items: Chair[] }>("/clinics/" + chosen + "/chairs", { signal: controller.signal }).then(result => {
      setChairs(result.items);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message || "无法读取牙椅资源。");
    });
    return () => controller.abort();
  }, [chosen, update]);

  async function stop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setError("");
    setPending(true);
    try {
      const result = await request<{ appointments_to_review: AppointmentSummary[] }>(
        "/chairs/" + data.get("chair_id") + "/unavailability",
        {
          method: "POST", actionKey: crypto.randomUUID(),
          body: { start_at: toOffset(data.get("start_at")), end_at: toOffset(data.get("end_at")), reason: data.get("reason") },
        },
      );
      setImpacted(result.appointments_to_review);
      setUpdate(previous => previous + 1);
      form.reset();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法登记牙椅停用。");
    } finally {
      setPending(false);
    }
  }

  return <section className="schedule-panel">
    <h2>牙椅停用</h2>
    <label>门店 <select value={chosen} onChange={event => {
      setChosen(event.target.value);
      setChairs([]);
      setImpacted(undefined);
      setError("");
    }}>
      {identity.clinics.map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>{clinic.name}</option>)}
    </select></label>
    {!readOnly && chairs.length > 0 && <form className="schedule-form" onSubmit={stop}>
      <label>牙椅<select name="chair_id" required>{chairs.map(c => <option value={c.chair_id} key={c.chair_id}>{c.chair_no}</option>)}</select></label>
      <label>开始<input name="start_at" type="datetime-local" required /></label>
      <label>结束<input name="end_at" type="datetime-local" required /></label>
      <label>原因<input name="reason" required /></label>
      <button className="button primary" disabled={pending}>登记停用</button>
    </form>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <ul className="compact-list">{chairs.map(chair => <li key={chair.chair_id}>
      <strong>{chair.chair_no}</strong><span>{chair.chair_kind}</span>
      {chair.unavailability.map(item => <span key={item.unavailability_id}>{localDate(item.start_at)} {localTime(item.start_at)}–{localTime(item.end_at)} {item.reason}</span>)}
    </li>)}</ul>
    {!chairs.length && !error && <p className="muted">当前门店没有可见牙椅。</p>}
    {impacted && <><h3>需复核的预约</h3><AffectedAppointments items={impacted} onAppointment={onAppointment} /></>}
  </section>;
}
