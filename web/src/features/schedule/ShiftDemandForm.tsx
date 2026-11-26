import { FormEvent, useEffect, useState } from "react";

import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import type { StaffIdentity } from "../../shared/AppShell";
import { localDate, localTime, toOffset } from "./types";

export type Demand = {
  demand_id: string;
  clinic_id: string;
  required_qualification_id: string | null;
  required_count: number;
  start_at: string;
  end_at: string;
};
type Qualification = { qualification_id: string; name: string };

export function ShiftDemandForm({ identity, clinicId }: { identity: StaffIdentity; clinicId: string }) {
  const request = useApiRequest();
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [demands, setDemands] = useState<Demand[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const manager = identity.capabilities.includes("CLINIC_MANAGER");

  useEffect(() => {
    const controller = new AbortController();
    const query = clinicId ? "?clinic_id=" + encodeURIComponent(clinicId) : "";
    Promise.all([
      request<{items: Qualification[]}>("/qualifications", { signal: controller.signal }),
      request<{items: Demand[]}>("/shift-demands" + query, { signal: controller.signal }),
    ]).then(([q, d]) => {
      setQualifications(q.items);
      setDemands(d.items);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message || "无法读取排班需求。");
    });
    return () => controller.abort();
  }, [clinicId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const inputs = new FormData(form);
    setPending(true);
    setError("");
    try {
      const item = await request<Demand>("/shift-demands", {
        method: "POST", actionKey: crypto.randomUUID(),
        body: {
          clinic_id: inputs.get("clinic_id"),
          start_at: toOffset(inputs.get("start_at")),
          end_at: toOffset(inputs.get("end_at")),
          required_qualification_id: inputs.get("qualification") || null,
          required_count: Number(inputs.get("required_count")),
        },
      });
      setDemands(old => [...old, item]);
      form.reset();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "无法提交排班需求。");
    } finally {
      setPending(false);
    }
  }

  return <section className="schedule-panel">
    <h2>排班需求</h2>
    {manager && (
      <form className="schedule-form" onSubmit={submit}>
        <label>门店<select name="clinic_id" defaultValue={clinicId || identity.clinics[0]?.clinic_id} required>
          {identity.clinics.map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>{clinic.name}</option>)}
        </select></label>
        <label>开始<input name="start_at" type="datetime-local" required /></label>
        <label>结束<input name="end_at" type="datetime-local" required /></label>
        <label>所需资格<select name="qualification"><option value="">不限</option>
          {qualifications.map(q => <option key={q.qualification_id} value={q.qualification_id}>{q.name}</option>)}
        </select></label>
        <label>人数<input name="required_count" type="number" min={1} defaultValue={1} required /></label>
        <button className="button primary" disabled={pending}>提交需求</button>
      </form>
    )}
    {error && <p className="error-text" role="alert">{error}</p>}
    <ul className="compact-list">
      {demands.map(demand => <li key={demand.demand_id}>
        <strong>{identity.clinics.find(c => c.clinic_id === demand.clinic_id)?.name}</strong>
        <span>{localDate(demand.start_at)} {localTime(demand.start_at)}–{localTime(demand.end_at)}</span>
        <span>{qualifications.find(q => q.qualification_id === demand.required_qualification_id)?.name || "不限资格"}</span>
        <span>{demand.required_count} 人</span>
      </li>)}
    </ul>
    {!demands.length && !error && <p className="muted">当前没有排班需求。</p>}
  </section>;
}
