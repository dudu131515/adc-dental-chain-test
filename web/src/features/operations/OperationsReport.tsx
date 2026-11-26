import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { FormEvent, useEffect, useRef, useState } from "react";
import { canWorkAt, StaffIdentity } from "../../shared/AppShell";
import { useApiRequest } from "../../shared/ApiTransport";
import { dateTime, errorMessage, money } from "../../shared/format";
import { AssistantDrilldown, AssistantPanel } from "./AssistantPanel";
import { ReportDetails } from "./ReportDetails";

type Rate = { numerator: number; denominator: number; value: string | null; availability: string };
type Counts = Record<"attended" | "patient_cancelled" | "no_show" | "unprocessed" | "clinic_cancelled", number>;
type OfficialVersion = { period_id: string; year: number; quarter: number; revision_no: number; company?: Record<string, string> };
type Report = {
  date_from: string; date_to: string; as_of: string; report_token: string;
  scope: { clinic_ids: string[]; dentist_ids: string[] };
  appointments: Counts & { denominator: number; attendance_rate: Rate; cancellation_rate: Rate; by_clinic: (Counts & { clinic_id: string })[] };
  clinical: { actual_starts: number; normal_completions: number; actual_treatments: number };
  standard_coverage: Rate;
  financial: Record<"accrued" | "received" | "refunded" | "net_received" | "outstanding", string>;
  skills: { code: string; name: string; dentists: number }[];
  performance: OfficialVersion[];
  sources: Record<string, string>;
  snapshot_refreshed?: boolean; original_as_of?: string;
};

const appointmentGroups = [
  ["attended", "实际接诊"], ["patient_cancelled", "患者主动取消"], ["no_show", "已核实爽约"],
  ["unprocessed", "到期未处置"], ["clinic_cancelled", "诊所原因取消"],
] as const;
const clinicalGroups = [
  ["actual_starts", "实际开始接诊"], ["normal_completions", "正常完成"], ["actual_treatments", "实际项目"],
] as const;
const financialGroups = [
  ["accrued", "应计收入"], ["received", "实收"], ["refunded", "退款"], ["net_received", "净实收"], ["outstanding", "欠款"],
] as const;

function ratio(rate: Rate) {
  if (rate.availability === "MISSING") return "缺少数据";
  if (rate.value === null) return "不适用";
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(Number(rate.value));
}

export function OperationsReport({ identity, clinicId, open, assistantWorkspace = false, inlineAssistantActive = true, initialQuery, assistantLink }: {
  identity: StaffIdentity; clinicId: string; open: (path: string) => void; assistantWorkspace?:boolean; inlineAssistantActive?:boolean;
  initialQuery?:string; assistantLink?:string;
}) {
  const { router, workday } = useWorkspaceRuntime();
  const request = useApiRequest();
  const today = workday;
  const reportingClinics = identity.clinics.filter(row => canWorkAt(identity, "HQ_OPERATIONS_QUERY", row.clinic_id));
  const [initial] = useState(() => new URLSearchParams(initialQuery ?? router.read().search));
  const [from, setFrom] = useState(initial.get("date_from") || today.slice(0, 7) + "-01");
  const [to, setTo] = useState(initial.get("date_to") || today);
  const [clinic, setClinic] = useState(initial.get("clinic_ids") ?? clinicId);
  const [dentist, setDentist] = useState(initial.get("dentist_ids") || "");
  const [report, setReport] = useState<Report>();
  const [fault, setFault] = useState("");
  const [busy, setBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState<{ key: string; label: string; clinic?: string }>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  function clinicName(id: string) {
    return identity.clinics.find(row => row.clinic_id === id)?.name ?? id;
  }

  function select(button: HTMLButtonElement, key: string, label: string, office?: string) {
    trigger.current = button;
    setSelected({ key, label, clinic: office });
  }

  function close() {
    setSelected(undefined);
    trigger.current?.focus();
  }

  const query = new URLSearchParams({ date_from: from, date_to: to });
  if (clinic) query.set("clinic_ids", clinic);
  if (dentist.trim()) query.set("dentist_ids", dentist.trim().replaceAll("，", ",").replaceAll(/\s+/g, ""));
  const context = query.toString();

  function changeFilter(key: string, value: string, setter: (value: string) => void) {
    setter(value);
    if (initialQuery !== undefined) return;
    const url = new URL(router.read().url, window.location.origin);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    router.write(url.pathname + url.search);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setReport(undefined);
    void loadReport("/reports/operations?" + context);
  }

  function resetOriginal() {
    abort.current?.abort();
    trigger.current = null;
    setReport(undefined);
    setFault("");
    setSelected(undefined);
    setBusy(false);
  }

  useEffect(() => {
    if (initial.has("date_from") && initial.has("date_to") && !assistantWorkspace) {
      void loadReport("/reports/operations?" + initial.toString());
    }
  }, []);

  function openOriginal(reference: string, button: HTMLButtonElement, detail?: AssistantDrilldown) {
    const query = new URLSearchParams({ reference });
    void loadReport("/reports/operations/assistant/report?" + query, button, detail);
  }

  async function loadReport(path: string, button?: HTMLButtonElement, detail?: AssistantDrilldown) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setFault("");
    setSelected(undefined);
    try {
      const result = await request<Report>(path, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setReport(result);
      if (button && detail) select(button, detail.key, detail.label);
      else if (button) heading.current?.focus();
    } catch (error) {
      if (!controller.signal.aborted) setFault(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="operations-sections">
    {!assistantWorkspace && <section className="schedule-panel">
      <div className="schedule-heading">
        <h2 ref={heading} tabIndex={-1}>查询经营报告</h2>
        {assistantLink ? <a className="button" href={assistantLink}>打开经营智能助手</a> : inlineAssistantActive &&
        identity.capabilities.includes("HQ_OPERATIONS_QUERY") && <button type="button" className="button"
          aria-expanded={assistantOpen} aria-controls="operations-assistant" onClick={() => setAssistantOpen(value => !value)}>
          经营分析助手
        </button>}
      </div>
      <form className="schedule-form" onSubmit={submit}>
        <label>开始日期<input type="date" required value={from} onChange={event => changeFilter("date_from", event.target.value, setFrom)} /></label>
        <label>结束日期<input type="date" required min={from} value={to} onChange={event => changeFilter("date_to", event.target.value, setTo)} /></label>
        <label>统计门店<select value={clinic} onChange={event => changeFilter("clinic_ids", event.target.value, setClinic)}>
          <option value="">全部授权门店</option>
          {reportingClinics.map(row => <option key={row.clinic_id} value={row.clinic_id}>{row.name}</option>)}
        </select></label>
        <label>牙医编号<input placeholder="全部，多个编号用逗号分隔" value={dentist} onChange={event => changeFilter("dentist_ids", event.target.value, setDentist)} /></label>
        <button className="button primary" disabled={busy}>查询</button>
      </form>
      {busy && <p role="status">正在生成报告…</p>}
      {fault && <p className="error-text" role="alert">{fault}</p>}
      {report && <p className="report-scope">
        {report.date_from} 至 {report.date_to} · {report.scope.clinic_ids.map(clinicName).join("、") || "无门店"}
        {" · "}{report.scope.dentist_ids.length ? "牙医 " + report.scope.dentist_ids.join("、") : "全部授权牙医"}
        {" · "}统计截止 {dateTime(report.as_of)}
      </p>}
      {report?.snapshot_refreshed && <p role="status">原分析快照已过期，已按原筛选重新查询。原截止 {dateTime(report.original_as_of)}，新截止 {dateTime(report.as_of)}。</p>}
    </section>}
    {(assistantWorkspace || (inlineAssistantActive && assistantOpen)) && identity.capabilities.includes("HQ_OPERATIONS_QUERY") &&
      <AssistantPanel key={context} accountId={identity.account_id} context={context} openOriginal={openOriginal}
        workspace={assistantWorkspace} resetOriginal={resetOriginal} />}
    {assistantWorkspace && (busy || fault || report) && <section className="schedule-panel">
      <h2 ref={heading} tabIndex={-1}>助手引用的原报表</h2>
      {busy && <p role="status">正在加载原报表…</p>}
      {fault && <p role="alert" className="error-text">{fault}</p>}
      {report && <p>{report.date_from} 至 {report.date_to} · 统计截止 {dateTime(report.as_of)}</p>}
      {report?.snapshot_refreshed && <p role="status">原分析快照已过期，已按原筛选重新查询。原截止 {dateTime(report.original_as_of)}，新截止 {dateTime(report.as_of)}。</p>}
    </section>}
    {report && <>
      <section className="schedule-panel">
        <h2>预约履约</h2>
        <p className="muted">{report.sources.appointments}。两项比率共用 {report.appointments.denominator} 笔正式预约。</p>
        <div className="report-metrics">
          {([["实际就诊率", "attended", report.appointments.attendance_rate],
            ["患者主动取消率", "patient_cancelled", report.appointments.cancellation_rate]] as const).map(([label, key, rate]) =>
            <button key={key} className="report-metric" onClick={event => select(event.currentTarget, key, label)}>
              <span>{label}</span><strong>{ratio(rate)}</strong><small>{rate.numerator}/{rate.denominator}</small>
            </button>)}
          {appointmentGroups.slice(2).map(([key, label]) => <button className="report-metric" key={key}
            onClick={event => select(event.currentTarget, key, label)}><span>{label}</span><strong>{report.appointments[key]}</strong></button>)}
        </div>
        {report.appointments.denominator > 0 && <div className="status-distribution" aria-label="分母内预约分布">
          {appointmentGroups.slice(0, 4).map(([key, label]) => report.appointments[key] > 0 &&
            <span key={key} data-group={key} title={label + " " + report.appointments[key]}
              style={{ flexGrow: report.appointments[key] }} />)}
        </div>}
        <div className="schedule-scroll"><table className="report-table">
          <thead><tr><th scope="col">门店</th>{appointmentGroups.map(([key, label]) => <th key={key} scope="col">{label}</th>)}</tr></thead>
          <tbody>{report.appointments.by_clinic.map(row => <tr key={row.clinic_id}><th scope="row">{clinicName(row.clinic_id)}</th>
            {appointmentGroups.map(([key, label]) => <td key={key}><button className="text-action"
              onClick={event => select(event.currentTarget, key, label, row.clinic_id)}
              aria-label={clinicName(row.clinic_id) + " " + label + " " + row[key]}>{row[key]}</button></td>)}
          </tr>)}</tbody>
        </table></div>
      </section>
      <section className="schedule-panel">
        <h2>诊疗与计费标准</h2>
        <p className="muted">{report.sources.clinical}。{report.sources.coverage}。</p>
        <div className="report-metrics">
          {clinicalGroups.map(([key, label]) => <button className="report-metric" key={key}
            onClick={event => select(event.currentTarget, key, label)}><span>{label}</span><strong>{report.clinical[key]}</strong></button>)}
          <button className="report-metric" onClick={event => select(event.currentTarget, "coverage", "结算标准覆盖")}>
            <span>结算标准覆盖率</span><strong>{ratio(report.standard_coverage)}</strong>
            <small>{report.standard_coverage.numerator}/{report.standard_coverage.denominator}</small>
          </button>
        </div>
      </section>
      <section className="schedule-panel">
        <h2>诊疗资金</h2><p className="muted">{report.sources.financial}。</p>
        <div className="report-metrics">{financialGroups.map(([key, label]) => <button className="report-metric" key={key}
          onClick={event => select(event.currentTarget, key, label)}><span>{label}</span><strong>{money(report.financial[key])}</strong></button>)}</div>
      </section>
      <section className="schedule-panel">
        <div className="schedule-heading"><h2>牙医资格与技能</h2><button className="button"
          onClick={event => select(event.currentTarget, "skills", "牙医资格")}>查看资格明细</button></div>
        <p className="muted">{report.sources.skills}。</p>
        {report.skills.length ? <ul className="compact-list">{report.skills.map(skill => <li key={skill.code}>{skill.name} · {skill.dentists} 人</li>)}</ul>
          : <p>当前范围无有效资格记录。</p>}
      </section>
      <section className="schedule-panel">
        <h2>正式季度绩效</h2><p className="muted">{report.sources.performance}。</p>
        {report.performance.length ? <ul className="compact-list">{report.performance.map(row => <li key={row.period_id}>
          <button className="text-action" onClick={() => open("/operations/quarters/" + row.period_id)}>
            {row.year} 年第 {row.quarter} 季度 · 第 {row.revision_no} 版
          </button>{row.company && <span>净利润 {money(row.company.net_profit)} · 基金 {money(row.company.incentive_fund)}</span>}
        </li>)}</ul> : <p>所选期间无已确认季度。</p>}
      </section>
      {selected && <ReportDetails key={report.report_token + ":" + selected.key + ":" + selected.clinic} token={report.report_token} metric={selected.key}
        label={selected.label} clinic={selected.clinic} onClose={close} />}
    </>}
  </div>;
}
