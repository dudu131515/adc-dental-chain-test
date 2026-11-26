import { FormEvent, useEffect, useRef, useState } from "react";
import { StaffIdentity } from "../../shared/AppShell";
import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import { errorMessage, money } from "../../shared/format";

export type Period = { period_id: string; year: number; quarter: number; status?: string; latest_confirmed_revision_no?: number };
type Expense = { expense_id: string; clinic_id: string; period_id: string; expense_category: string; scope: string;
  amount: string; dentist_id?: string; evidence_ref?: string };
const blank = { period_id: "", expense_category: "", amount: "", scope: "SHARED", dentist_id: "", evidence_ref: "" };

export function ExpensesPage({ identity, clinicId }: { identity: StaffIdentity; clinicId: string }) {
  const request = useApiRequest();
  const manager = identity.capabilities.includes("CLINIC_MANAGER");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [items, setItems] = useState<Expense[]>([]);
  const [fields, setFields] = useState(blank);
  const [filter, setFilter] = useState("");
  const [fault, setFault] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sequence, setSequence] = useState(0);
  const action = useRef<{ body: unknown; key: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (clinicId) query.set("clinic_id", clinicId);
    if (filter) query.set("period_id", filter);
    setLoading(true);
    Promise.all([
      request<{ items: Period[] }>("/performance/periods", { signal: controller.signal }),
      request<{ items: Expense[] }>("/expenses?" + query, { signal: controller.signal }),
    ]).then(([quarters, expenses]) => {
      if (controller.signal.aborted) return;
      setPeriods(quarters.items);
      setItems(expenses.items);
    }).catch(error => { if (!controller.signal.aborted) setFault(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [clinicId, filter, sequence]);

  const update = (field: keyof typeof blank, value: string) => setFields(current => ({ ...current, [field]: value }));
  const quarterName = (id: string) => {
    const period = periods.find(row => row.period_id === id);
    return period ? period.year + " 年第 " + period.quarter + " 季度" : id;
  };
  const clinicName = (id: string) => identity.clinics.find(row => row.clinic_id === id)?.name ?? id;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action.current) action.current = { key: crypto.randomUUID(), body: {
      ...fields, clinic_id: clinicId, dentist_id: fields.scope === "DIRECT" ? fields.dentist_id : null,
    } };
    setBusy(true); setFault(""); setMessage("");
    try {
      await request("/expenses", { method: "POST", body: action.current.body, actionKey: action.current.key });
      action.current = null;
      setFields(blank);
      setSequence(sequence + 1);
      setMessage("费用已登记。");
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 0) action.current = null;
      setFault(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <div className="operations-sections">
    <section className="schedule-panel">
      <h2>运营费用</h2>
      {fault && <p className="error-text" role="alert">{fault}</p>}
      {message && <p role="status">{message}</p>}
      {manager && (clinicId ? periods.length ? <form className="schedule-form" onSubmit={submit}>
        <fieldset className="record-fields" disabled={busy || action.current !== null}>
          <label>登记季度<select required value={fields.period_id} onChange={event => update("period_id", event.target.value)}>
            <option value="">选择季度</option>{periods.map(row => <option key={row.period_id} value={row.period_id}>{quarterName(row.period_id)}</option>)}
          </select></label>
          <label>费用类别<input required maxLength={100} value={fields.expense_category} onChange={event => update("expense_category", event.target.value)} /></label>
          <label>金额（元）<input required type="number" min="0" step="0.01" value={fields.amount} onChange={event => update("amount", event.target.value)} /></label>
          <label>归属方式<select value={fields.scope} onChange={event => update("scope", event.target.value)}>
            <option value="SHARED">共同费用</option><option value="DIRECT">直接费用</option>
          </select></label>
          {fields.scope === "DIRECT" && <label>牙医编号<input required inputMode="numeric" pattern="[0-9]+" value={fields.dentist_id} onChange={event => update("dentist_id", event.target.value)} /></label>}
          <label>凭据引用<input required maxLength={180} value={fields.evidence_ref} onChange={event => update("evidence_ref", event.target.value)} /></label>
        </fieldset>
        <button className="button primary" disabled={busy}>{action.current ? "核对原登记" : "登记费用"}</button>
      </form> : <p>暂无可登记期间，请由有核算权限的人员建立期间。</p> : <p>选择本店后可登记费用。</p>)}
    </section>
    <section className="schedule-panel">
      <div className="schedule-heading"><h2>费用明细</h2>
        <label className="clinic-picker">筛选季度<select value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="">全部季度</option>{periods.map(row => <option key={row.period_id} value={row.period_id}>{quarterName(row.period_id)}</option>)}
        </select></label>
      </div>
      {loading ? <p role="status">正在读取费用…</p> : items.length ? <div className="schedule-scroll"><table className="report-table">
        <thead><tr>{["门店", "季度", "费用类别", "金额", "费用归属", "凭据"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(row => <tr key={row.expense_id}><td>{clinicName(row.clinic_id)}</td><td>{quarterName(row.period_id)}</td>
          <th scope="row">{row.expense_category}</th><td>{money(row.amount)}</td>
          <td>{row.scope === "DIRECT" ? "牙医 " + row.dentist_id : "共同"}</td><td>{row.evidence_ref ?? "缺少数据"}</td>
        </tr>)}</tbody>
      </table></div> : <p>所选范围暂无费用记录。</p>}
    </section>
  </div>;
}
