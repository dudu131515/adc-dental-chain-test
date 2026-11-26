import { FormEvent, useEffect, useRef, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import { StaffIdentity } from "../../shared/AppShell";
import { dateTime, errorMessage, money } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { Candidate, fundingStates, FundsStatus } from "./appointmentTypes";
import { localTime } from "./types";
import type { BookingPreference } from "./DaySchedule";

export type Patient = { patient_id: string; patient_no: string; full_name: string; birth_date: string; phone: string };
type Project = { treatment_type_id: string; treatment_name: string; default_slot_minutes: number | null; active: boolean };
type Hold = {
  claim_id: string; status: string; start_at: string; expires_at: string; server_time: string; appointment_id?: string; appointment_no?: string;
  payment: { deposit_id: string; amount: string; status: string };
};
type Payment = Hold["payment"] & { appointment_id?: string; appointment_no?: string; claim_status: string; refund?: FundsStatus };

type HoldPayload = {
  clinic_id: string; patient_id: string; treatment_type_id: string; shift_id: string; dentist_id: string;
  start_at: string; end_at: string; estimated_minutes?: string;
};
type HoldAttempt = {
  key: string; payload: HoldPayload; hasNote?: boolean; fingerprint?: string; confirmedHold?: boolean; previous?: boolean;
};

function savedHolds(storageKey: string): HoldAttempt[] {
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null");
    return Array.isArray(saved) ? saved.filter(record => record?.key && record.payload?.patient_id) : [];
  } catch {
    return [];
  }
}

async function fingerprint(key: string, payload: object) {
  const value = new TextEncoder().encode(key + JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function lookupHold(request: ReturnType<typeof useApiRequest>, attempt: HoldAttempt) {
  const { clinic_id, patient_id } = attempt.payload;
  try {
    return await request<Hold>("/holds/by-action?" + new URLSearchParams({ clinic_id, patient_id }), { actionKey: attempt.key });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

export function RegisterPatient({ clinic, onSaved, expanded = false }: { clinic: string; onSaved: (row: Patient) => void; expanded?: boolean }) {
  const action = useAction();
  const fields = [
    ["full_name", "患者姓名", "text"], ["birth_date", "出生日期", "date"], ["phone", "联系电话", "tel"],
    ["billing_address", "账单地址", "text"], ["email", "电子邮箱（选填）", "email"],
    ["emergency_name", "紧急联系人", "text"], ["emergency_phone", "紧急联系电话", "tel"],
  ];
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    if (!body.email) delete body.email;
    action.execute<Patient>("/clinics/" + clinic + "/patients", body, onSaved);
  }
  return <details open={expanded || undefined}>
    <summary>登记新患者</summary>
    <ActionFeedback {...action} />
    <form className="schedule-form" onSubmit={save}>
      <fieldset className="record-fields" disabled={action.busy || action.unknown}>
        {fields.map(([id, title, kind]) => <label key={id}>
          {title}<input name={id} type={kind} required={id !== "email"} />
        </label>)}
      </fieldset>
      <button className="button" disabled={action.busy || action.unknown}>保存患者档案</button>
    </form>
  </details>;
}

function depositFromHold(hold: Hold): Payment {
  return { ...hold.payment, claim_status: hold.status, appointment_id: hold.appointment_id, appointment_no: hold.appointment_no };
}

function DepositStep({ hold, resumed, onOpen, onReset }: {
  hold: Hold; resumed: boolean; onOpen: (id: string) => void; onReset: (keep: boolean) => void;
}) {
  const request = useApiRequest();
  const [payment, setPayment] = useState<Payment>(() => depositFromHold(hold));
  const [clockOffset] = useState(() => Date.parse(hold.server_time) - Date.now());
  const [clock, setClock] = useState(Date.now);
  const [fault, setFault] = useState("");
  const [read, setRead] = useState(resumed ? 1 : 0);
  const [reading, setReading] = useState(resumed);
  const [verified, setVerified] = useState(!resumed);
  const action = useAction();
  const locked = reading || !verified || action.busy || action.unknown;
  const seconds = Math.max(0, Math.ceil((Date.parse(hold.expires_at) - (clock + clockOffset)) / 1000));
  const base = "/deposit-payments/" + hold.payment.deposit_id;
  const claim = "/holds/" + hold.claim_id;
  useEffect(() => {
    const tick = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);
  useEffect(() => {
    if (!read) return;
    const controller = new AbortController();
    setReading(true);
    request<Payment>(base, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setPayment(result); setVerified(true); setFault("");
    }).catch(error => {
      if (!controller.signal.aborted) { setVerified(false); setFault(errorMessage(error)); }
    }).finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [base, read, request]);

  function release() {
    action.execute<Hold>(claim + "/release", {}, result => {
      if (!result.appointment_id && result.payment.status === "NOT_STARTED") onReset(false);
      else {
        setPayment(depositFromHold(result));
        setRead(value => value + 1);
      }
    }, async () => {
      const result = await request<Hold>(claim);
      return result.status === "HOLD" ? undefined : result;
    });
  }

  const active = payment.claim_status === "HOLD" && seconds > 0;
  return <section>
    <h3>确认预约金</h3>
    {resumed && <p>正在查看原代办预约的结果。</p>}
    {reading && <p role="status">正在核对原预约金…</p>}
    {verified && <>
      <p>{dateTime(hold.start_at)} · 金额 {money(payment.amount)} · {fundingStates[payment.status] ?? payment.status}</p>
      {active && !payment.appointment_id && <p>占位剩余 {Math.floor(seconds / 60)} 分 {seconds % 60} 秒</p>}
      {(payment.claim_status === "EXPIRED" || seconds === 0) && !payment.appointment_id && <p>占位已到期，请核对原预约金后重新选时。</p>}
      {payment.claim_status === "RELEASED" && !payment.appointment_id && <p>占位已释放，预约未确认。</p>}
      {payment.refund && <p>原路退金 {money(payment.refund.amount)} · {fundingStates[payment.refund.status] ?? payment.refund.status}</p>}
    </>}
    <ActionFeedback {...action} />
    {fault && <p className="error-text" role="alert">{fault}</p>}
    <div className="schedule-toolbar">
      {verified && payment.appointment_id ? <button className="button primary" onClick={() => payment.appointment_id && onOpen(payment.appointment_id)}>
        查看正式预约 {payment.appointment_no}
      </button> : <>
        {verified && active && payment.status === "NOT_STARTED" &&
          <button className="button primary" disabled={locked} onClick={() => action.execute<Payment>(base + "/simulate", {}, setPayment, async () => {
            const result = await request<Payment>(base);
            return result.status === "NOT_STARTED" && result.claim_status === "HOLD" ? undefined : result;
          })}>提交模拟预约金付款</button>}
        <button className="button" disabled={reading || action.busy} onClick={() => { setReading(true); setRead(value => value + 1); }}>核对预约金结果</button>
        {verified && !active && payment.status !== "PENDING" &&
          <button className="button" disabled={locked} onClick={() => onReset(payment.status !== "NOT_STARTED"
            && payment.refund?.status !== "SUCCEEDED")}>重新选择时段</button>}
        {verified && active && ["NOT_STARTED", "PENDING"].includes(payment.status) &&
          <button className="button" disabled={locked} onClick={release}>
            {payment.status === "PENDING" ? "释放占位并继续跟踪付款与退金" : "释放占位"}
          </button>}
      </>}
    </div>
  </section>;
}

type BookingProps = {
  identity: StaffIdentity; clinic: string; date: string; initialPatient?: Patient; preference?: BookingPreference; onAppointment: (id: string) => void;
};

export function BookingForm(props: BookingProps) {
  const storageKey = "adc:hold:" + props.identity.account_id + ":" + props.clinic;
  return <BookingWorkflow key={storageKey} {...props} storageKey={storageKey} />;
}

function BookingWorkflow({ identity, clinic, date, onAppointment, initialPatient, preference, storageKey }: BookingProps & { storageKey: string }) {
  const request = useApiRequest();
  const [text, setText] = useState("");
  const [criteria, setCriteria] = useState<string>();
  const [patient, setPatient] = useState<Patient | undefined>(initialPatient);
  const [project, setProject] = useState("");
  const [dentist, setDentist] = useState(preference?.dentistId ?? "");
  const [minutes, setMinutes] = useState("");
  const [evidence, setEvidence] = useState("");
  const [preferred, setPreferred] = useState(preference?.time ?? "");
  const [note, setNote] = useState("");
  const [query, setQuery] = useState<string>();
  const [change, setChange] = useState(0);
  const [candidate, setCandidate] = useState<Candidate>();
  const [hold, setHold] = useState<{ value: Hold; record: HoldAttempt; resumed: boolean }>();
  const [saved, setSaved] = useState(() => savedHolds(storageKey));
  const [original, setOriginal] = useState(() => saved.find(record => !record.previous));
  const [canRetry, setCanRetry] = useState(false);
  const [checking, setChecking] = useState(false);
  const [recoveryFault, setRecoveryFault] = useState("");
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const preparing = useRef(false);
  const mounted = useRef(true);
  const action = useAction();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const patients = useRead<{ items: Patient[] }>(criteria === undefined ? undefined
    : "/clinics/" + clinic + "/patients?" + new URLSearchParams({ q: criteria }));
  const catalog = useRead<{ items: Project[] }>("/catalog/treatments");
  const dentists = useRead<{ items: { dentist_id: string; name: string }[] }>("/schedule/dentists?clinic_id=" + clinic);
  const options = useRead<{ items: Candidate[] }>(query, change);
  const selected = catalog.data?.items.find(item => item.treatment_type_id === project);
  const locked = checking || action.busy || action.unknown;
  const requiresEstimate = selected?.default_slot_minutes === null;
  const clinicName = identity.clinics.find(row => row.clinic_id === clinic)?.name;

  function findOptions(time: string) {
    const params = new URLSearchParams({ clinic_id: clinic, date, treatment_type_id: project });
    if (dentist) params.set("dentist_id", dentist);
    if (requiresEstimate) { params.set("estimated_minutes", minutes); params.set("estimate_evidence", evidence); }
    if (time) params.set("preferred_start_at", date + "T" + time + ":00+08:00");
    setCandidate(undefined); setQuery("/booking/options?" + params); setChange(value => value + 1);
  }

  function saveAttempt(attempt: HoldAttempt, remove = false) {
    const stored = savedHolds(storageKey);
    const remaining = stored.filter(record => record.key !== attempt.key);
    const next = remove ? remaining : [...remaining, attempt];
    try {
      if (next.length) window.sessionStorage.setItem(storageKey, JSON.stringify(next));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      setRecoveryNotice("浏览器无法保存原操作，关闭前请先核对办理结果。");
    }
    setSaved(next);
  }

  function complete(record: HoldAttempt, value: Hold, resumed: boolean) {
    const confirmed = { ...record, confirmedHold: true };
    saveAttempt(confirmed);
    setHold({ value, record: confirmed, resumed });
  }

  function submitHold(record: HoldAttempt, payload: object, recovering: boolean) {
    let attemptedWrite = !recovering;
    action.execute<Hold>("/holds", payload, result => complete(record, result, !attemptedWrite), async () => {
      const result = await lookupHold(request, record);
      attemptedWrite = !result;
      return result;
    }, {
      actionKey: record.key,
      recover: recovering,
      onStart: () => saveAttempt(record),
      onRejection: () => {
        if (attemptedWrite) {
          saveAttempt(record, true);
          setOriginal(undefined); setCanRetry(false);
        }
      },
    });
  }

  async function checkOriginal(attempt: HoldAttempt) {
    if (checking || action.busy || action.unknown) return;
    setChecking(true); setRecoveryFault(""); setCanRetry(false);
    setOriginal(attempt);
    try {
      const result = await lookupHold(request, attempt);
      if (result) complete(attempt, result, true);
      else if (attempt.confirmedHold) setRecoveryFault("当前无法查询原占位，请核对门店权限后重试。");
      else setCanRetry(true);
    } catch (error) {
      setRecoveryFault(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  function withInput(attempt: HoldAttempt) {
    return {
      ...attempt.payload,
      ...(attempt.payload.estimated_minutes ? { estimate_evidence: evidence } : {}),
      ...(attempt.hasNote ? { special_requirement: note.trim() } : {}),
    };
  }

  async function reserve(retry = false) {
    if (locked || preparing.current) return;
    let record = original;
    if (!retry) {
      if (!patient || !candidate) return;
      record = { key: crypto.randomUUID(), payload: {
        clinic_id: clinic, patient_id: patient.patient_id, treatment_type_id: candidate.treatment_type_id,
        shift_id: candidate.shift_id, dentist_id: candidate.dentist_id, start_at: candidate.start_at, end_at: candidate.end_at,
        ...(requiresEstimate ? { estimated_minutes: minutes } : {}),
      }, hasNote: Boolean(note.trim()) };
    }
    if (!record) return;

    setRecoveryFault("");
    const payload = withInput(record);
    if (record.hasNote || record.payload.estimated_minutes) {
      preparing.current = true;
      setChecking(true);
      try {
        const digest = await fingerprint(record.key, payload);
        if (!mounted.current) return;
        if (retry && digest !== record.fingerprint) {
          setRecoveryFault("输入与原操作不一致，请重新输入原资料。");
          return;
        }
        record = { ...record, fingerprint: digest };
      } catch (error) {
        if (mounted.current) setRecoveryFault(errorMessage(error));
        return;
      } finally {
        preparing.current = false;
        if (mounted.current) setChecking(false);
      }
    }
    submitHold(record, payload, retry);
  }

  function reset(record: HoldAttempt, keep: boolean) {
    saveAttempt({ ...record, previous: true }, !keep);
    setOriginal(undefined); setCanRetry(false); setHold(undefined); setCandidate(undefined);
    setRecoveryFault(""); setNote(""); setEvidence("");
    setChange(value => value + 1);
  }

  return <section>
    <p>{clinicName} · {date}</p>
    {recoveryNotice && <p role="status">{recoveryNotice}</p>}
    {recoveryFault && <p className="error-text" role="alert">{recoveryFault}</p>}
    {hold ? <DepositStep key={hold.value.claim_id} hold={hold.value} resumed={hold.resumed}
      onOpen={id => { saveAttempt(hold.record, true); onAppointment(id); }}
      onReset={keep => reset(hold.record, keep)} /> : original ? <section className="schedule-form">
      <p>此门店有一笔原代办预约，先核对实际结果。</p>
      <button className="button" disabled={locked} onClick={() => void checkOriginal(original)}>核对原预约占位</button>
      {canRetry && <form className="schedule-form" onSubmit={event => { event.preventDefault(); void reserve(true); }}>
        <p>当前未查到已提交的占位，可按同一操作重试。</p>
        <fieldset className="record-fields" disabled={locked}>
          {original.payload.estimated_minutes && <label>原估时依据<input required value={evidence} onChange={event => setEvidence(event.target.value)} /></label>}
          {original.hasNote && <label>原特殊需求<input required value={note} onChange={event => setNote(event.target.value)} /></label>}
        </fieldset>
        <button className="button primary" disabled={locked}>按原资料重试占位</button>
      </form>}
    </section> : <>
      {saved.filter(record => record.previous).map(record => <button key={record.key} className="button"
        disabled={locked} onClick={() => void checkOriginal(record)}>核对之前的预约金 {dateTime(record.payload.start_at)}</button>)}
      <form className="schedule-form" onSubmit={event => { event.preventDefault(); setCriteria(text.trim()); }}>
        <label>查找本店患者<input required disabled={locked} value={text} onChange={event => setText(event.target.value)} placeholder="姓名、患者编号或电话" /></label>
        <button className="button" disabled={locked}>查找</button>
      </form>
      {patients.loading && <p role="status">正在查找患者…</p>}
      {patients.fault && <p className="error-text" role="alert">{patients.fault}</p>}
      {patients.data && <ul className="compact-list">{patients.data.items.map(row => <li key={row.patient_id}>
        <button className="button" disabled={locked} onClick={() => setPatient(row)}>{row.full_name} · {row.patient_no}</button>
        <span>{row.birth_date} · {row.phone}</span>
      </li>)}</ul>}
      {patients.data?.items.length === 0 && <p>没有找到本店患者。</p>}
      {!locked && <RegisterPatient clinic={clinic} onSaved={setPatient} />}
      {patient && <p>已选 {patient.full_name} · {patient.patient_no}</p>}
      <form className="schedule-form" onSubmit={event => { event.preventDefault(); findOptions(preferred); }}>
        <fieldset className="record-fields" disabled={locked}>
          <label>主诊项目<select required value={project} onChange={event => { setProject(event.target.value); setQuery(undefined); setCandidate(undefined); }}>
            <option value="">选择项目</option>
            {catalog.data?.items.filter(row => row.active).map(row =>
              <option key={row.treatment_type_id} value={row.treatment_type_id}>{row.treatment_name}</option>)}
          </select></label>
          <label>牙医<select required={requiresEstimate} value={dentist} onChange={event => { setDentist(event.target.value); setQuery(undefined); setCandidate(undefined); }}>
            <option value="">全部可约牙医</option>
            {dentists.data?.items.map(row => <option key={row.dentist_id} value={row.dentist_id}>{row.name}</option>)}
          </select></label>
          {requiresEstimate && <>
            <label>牙医估时（分钟）<input required type="number" min="1" value={minutes} onChange={event => { setMinutes(event.target.value); setQuery(undefined); setCandidate(undefined); }} /></label>
            <label>估时依据<input required value={evidence} onChange={event => { setEvidence(event.target.value); setQuery(undefined); setCandidate(undefined); }} /></label>
          </>}
          <label>意向开始时间<input type="time" value={preferred} onChange={event => { setPreferred(event.target.value); setQuery(undefined); setCandidate(undefined); }} /></label>
        </fieldset>
        <button className="button" disabled={locked || !patient}>查询可约时段</button>
      </form>
      {(catalog.fault || dentists.fault || options.fault) && <p className="error-text" role="alert">{catalog.fault || dentists.fault || options.fault}</p>}
      {options.loading && <p role="status">正在核对资格、班次和牙椅…</p>}
      {options.data && !options.data.items.length && <div className="schedule-toolbar">
        <p>没有符合条件的时段。</p>
        {preferred && <button className="button" disabled={locked} onClick={() => { setPreferred(""); findOptions(""); }}>
          改查当天其他时段
        </button>}
      </div>}
      <ul className="compact-list">{options.data?.items.map(row => <li key={row.shift_id + row.start_at}>
        <button className="button" aria-pressed={candidate === row} disabled={locked} onClick={() => setCandidate(row)}>
          {localTime(row.start_at)}–{localTime(row.end_at)} · {row.dentist_name}
        </button>
      </li>)}</ul>
      {candidate && <div className="schedule-form">
        <label>特殊需求（选填）<input disabled={locked} value={note} onChange={event => setNote(event.target.value)} /></label>
        <button className="button primary" disabled={locked || !patient} onClick={() => void reserve()}>确认临时占位</button>
      </div>}
    </>}
    <ActionFeedback {...action} />
  </section>;
}
