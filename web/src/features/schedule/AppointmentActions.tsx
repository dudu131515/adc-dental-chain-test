import { FormEvent, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { ApiError, request } from "../../shared/api";
import { canWorkAt, StaffIdentity } from "../../shared/AppShell";
import { dateTime, money } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { Appointment, Candidate } from "./appointmentTypes";
import { localDate, localTime } from "./types";

type ChangeResult = { evidence_id: string };
type Quote = { expected_claim_id: string; refund_amount: string; cause: string };
type ActionName = "change" | "cancel" | "review" | "no_show" | "coordinate";

function ChangeAppointment({ row, identity, onChange }: { row: Appointment; identity: StaffIdentity; onChange: () => void }) {
  const front = row.allowed_actions.includes("reschedule");
  const coordinate = row.allowed_actions.includes("coordinate");
  const [cause, setCause] = useState(front ? "PATIENT" : "CLINIC");
  const [clinic, setClinic] = useState(row.clinic.clinic_id);
  const [date, setDate] = useState(localDate(row.start_at));
  const [selected, setSelected] = useState<Candidate>();
  const [path, setPath] = useState<string>();
  const [reason, setReason] = useState("");
  const [consent, setConsent] = useState("");
  const [sequence, setSequence] = useState(0);
  const action = useAction();
  const options = useRead<{ items: Candidate[] }>(path, sequence);
  const current = "/appointments/" + row.appointment_id;
  const locked = action.busy || action.unknown;
  const clinics = identity.clinics.filter(item => (
    cause === "PATIENT" ? ["FRONT_DESK"] : ["FRONT_DESK", "CLINIC_MANAGER", "HQ_SCHEDULER"]
  ).some(role => canWorkAt(identity, role, item.clinic_id)));

  function search(event: FormEvent) {
    event.preventDefault();
    setSelected(undefined);
    setPath("/booking/options?" + new URLSearchParams({
      clinic_id: clinic, date, treatment_type_id: row.treatment.treatment_type_id, appointment_id: row.appointment_id,
    }));
    setSequence(value => value + 1);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    action.execute<Appointment>(current + "/reschedule", {
      clinic_id: selected.clinic_id, dentist_id: selected.dentist_id, shift_id: selected.shift_id,
      start_at: selected.start_at, end_at: selected.end_at, expected_claim_id: row.claim_id,
      cause, reason, ...(cause === "CLINIC" ? { patient_consent_ref: consent } : {}),
    }, onChange, async () => {
      try {
        const updated = await request<Appointment>(current);
        return updated.claim_id !== row.claim_id && updated.clinic.clinic_id === selected.clinic_id
          && updated.dentist.dentist_id === selected.dentist_id && Date.parse(updated.start_at) === Date.parse(selected.start_at) ? updated : undefined;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        await request(current + "/handover-evidence");
        onChange();
        return row;
      }
    });
  }

  return <section className="appointment-action">
    <h3>核对改期安排</h3>
    <p>原时段 {dateTime(row.start_at)} · {row.clinic.name}。新安排生效前保留原预约。</p>
    {row.change_deadline_at && <p>患者改期截止 {dateTime(row.change_deadline_at)}</p>}
    <form className="schedule-form" onSubmit={search}>
      <fieldset className="record-fields" disabled={locked}>
        <label>改期原因类型<select value={cause} onChange={event => {
          setCause(event.target.value); setClinic(row.clinic.clinic_id); setSelected(undefined); setPath(undefined);
        }}>
          {front && <option value="PATIENT">患者原因</option>}{coordinate && <option value="CLINIC">诊所原因</option>}
        </select></label>
        <label>承接门店<select required value={clinic} onChange={event => { setClinic(event.target.value); setSelected(undefined); setPath(undefined); }}>
          {clinics.map(item => <option key={item.clinic_id} value={item.clinic_id}>{item.name}</option>)}
        </select></label>
        <label>目标日期<input type="date" required value={date} onChange={event => { setDate(event.target.value); setSelected(undefined); setPath(undefined); }} /></label>
      </fieldset>
      <button className="button" disabled={locked}>查询替代时段</button>
    </form>
    {options.loading && <p role="status">正在核对替代时段…</p>}
    {options.fault && <p className="error-text" role="alert">{options.fault}</p>}
    {options.data && !options.data.items.length && <p>没有可用的候选时段。可记录患者意向并保留原预约。</p>}
    <ul className="compact-list">{options.data?.items.map(item => <li key={item.shift_id + item.start_at}>
      <button className="button" aria-pressed={selected === item} onClick={() => setSelected(item)} disabled={locked}>
        {localTime(item.start_at)}–{localTime(item.end_at)} · {item.dentist_name}
      </button>
    </li>)}</ul>
    {selected && <form className="schedule-form" onSubmit={submit}>
      <fieldset className="record-fields" disabled={locked}>
        <label>改期说明<input required value={reason} onChange={event => setReason(event.target.value)} /></label>
        {cause === "CLINIC" && <label>患者已同意的凭据<input required value={consent} onChange={event => setConsent(event.target.value)} /></label>}
      </fieldset>
      <button className="button primary" disabled={locked}>确认所选新时段</button>
    </form>}
    <ActionFeedback {...action} />
  </section>;
}

export function AppointmentActions({ row, identity, onUpdate }: { row: Appointment; identity: StaffIdentity; onUpdate: () => void }) {
  const [mode, setMode] = useState<ActionName>();
  const [cause, setCause] = useState("PATIENT");
  const [reason, setReason] = useState("");
  const [intent, setIntent] = useState("");
  const [review, setReview] = useState("CONTINUE");
  const [evidence, setEvidence] = useState("");
  const [absent, setAbsent] = useState(false);
  const [able, setAble] = useState(false);
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState("");
  const action = useAction();
  const locked = action.busy || action.unknown;
  const { allowed_actions: permissions } = row;
  const coordinator = permissions.includes("coordinate");
  const patientCancel = permissions.includes("cancel");
  const canClinicQuote = coordinator && !permissions.includes("cancellation_review");
  const base = "/appointments/" + row.appointment_id;
  const quote = useRead<Quote>(mode === "cancel" ? base + "/cancellation-quote?cause=" + cause : undefined, reload);

  function select(next: ActionName) {
    setReason(""); setIntent(""); setEvidence(""); setReview("CONTINUE"); setMessage("");
    setAbsent(false); setAble(false); setCause(patientCancel ? "PATIENT" : "CLINIC"); setMode(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const common = { expected_claim_id: row.claim_id, reason };
    const validEvidence = evidence.trim() ? { coordination_evidence: evidence.trim() } : {};
    if (mode === "coordinate") {
      action.execute<ChangeResult>(base + "/coordination-intents", {
        expected_claim_id: row.claim_id, impact: reason, patient_intent: intent,
      }, result => { setMode(undefined); setMessage("已登记本店协调凭据 " + result.evidence_id + "，保留当前预约。"); });
      return;
    }
    const success = () => {
      setMessage(mode === "review" && review === "CONTINUE" ? "已登记核实结果，继续接诊。" : "已更新预约办理结果。");
      setMode(undefined); onUpdate();
    };
    if (mode === "cancel" && quote.data) {
      action.execute(base + "/cancel", { ...common, cause, quoted_refund_amount: quote.data.refund_amount, ...validEvidence }, success);
    }
    if (mode === "review") action.execute(base + "/cancellation-review", { ...common, conclusion: review, ...validEvidence }, success);
    if (mode === "no_show") action.execute(base + "/no-show", { ...common, patient_absent: absent, clinic_able: able }, success);
  }

  if (!permissions.length) return null;
  return <section className="appointment-action">
    <h3>预约变更与核实</h3>
    {message && <p role="status">{message}</p>}
    <div className="schedule-toolbar">
      {(permissions.includes("reschedule") || coordinator) && <button className="button" disabled={locked}
        onClick={() => select("change")}>查询并办理改期</button>}
      {(patientCancel || canClinicQuote) && <button className="button" disabled={locked} onClick={() => select("cancel")}>核对取消与退金</button>}
      {permissions.includes("cancellation_review") && <button className="button" disabled={locked} onClick={() => select("review")}>核实是否继续接诊</button>}
      {permissions.includes("review_no_show") && <button className="button" disabled={locked} onClick={() => select("no_show")}>人工核实爽约</button>}
      {coordinator && <button className="button" disabled={locked} onClick={() => select("coordinate")}>登记本店影响与患者意向</button>}
    </div>
    {mode === "change" && <ChangeAppointment row={row} identity={identity} onChange={() => {
      setMode(undefined); setMessage("请核对最新预约或本店交接记录。"); onUpdate();
    }} />}
    {mode && mode !== "change" && <form className="schedule-form" onSubmit={submit}>
      <fieldset className="record-fields" disabled={locked}>
        {mode === "cancel" && <label>取消归属<select value={cause} onChange={event => setCause(event.target.value)}>
          {patientCancel && <option value="PATIENT">患者原因</option>}{canClinicQuote && <option value="CLINIC">诊所原因</option>}
        </select></label>}
        {mode === "review" && <label>核实结论<select value={review} onChange={event => setReview(event.target.value)}>
          <option value="CONTINUE">继续接诊</option><option value="PATIENT_CANCEL">患者原因取消</option><option value="CLINIC_CANCEL">诊所原因取消</option>
        </select></label>}
        <label>{mode === "coordinate" ? "本店影响" : "原因及核对结论"}<input required value={reason} onChange={event => setReason(event.target.value)} /></label>
        {mode === "coordinate" && <label>患者意向<input required value={intent} onChange={event => setIntent(event.target.value)} /></label>}
        {((mode === "cancel" && cause === "CLINIC") || (mode === "review" && review === "CLINIC_CANCEL")) &&
          <label>同店替代及未达成履约的依据<input value={evidence} onChange={event => setEvidence(event.target.value)} /></label>}
        {mode === "no_show" && <>
          <label className="inline-control"><input type="checkbox" checked={absent} onChange={event => setAbsent(event.target.checked)} />已核实患者未到诊</label>
          <label className="inline-control"><input type="checkbox" checked={able} onChange={event => setAble(event.target.checked)} />本店原安排可履约</label>
        </>}
      </fieldset>
      {mode === "cancel" && <>
        {quote.loading && <p role="status">正在取得退金报价…</p>}
        {quote.fault && <p className="error-text" role="alert">{quote.fault}</p>}
        {quote.data && <p>当前退金报价 {money(quote.data.refund_amount)}</p>}
        <button type="button" disabled={locked || quote.loading} className="button" onClick={() => setReload(value => value + 1)}>重新核对报价</button>
      </>}
      <button className="button primary" disabled={locked || (mode === "cancel" && (!quote.data || quote.loading))
        || (mode === "no_show" && (!absent || !able))}>
        {mode === "cancel" ? "确认按报价取消" : mode === "review" ? "保存核实结果" : mode === "no_show" ? "确认爽约" : "保存协调意向"}
      </button>
    </form>}
    <ActionFeedback {...action} />
  </section>;
}
