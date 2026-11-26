import { FormEvent, useEffect, useRef, useState } from "react";
import { AgentCanvas, AgentComposer, AgentTurn } from "./AgentCanvas";
import { ApiError, request } from "../../shared/api";
import { dateTime, errorMessage, money } from "../../shared/format";

const path = "/reports/operations/assistant";
const labels = {
  attendance_rate: "实际就诊率", unprocessed: "到期未处置",
  net_received: "诊疗净实收", deposit_refund: "预约金退还规则", report_rules: "预约统计口径",
} as const;
const moneyLabels = { received: "实收", refunded: "退款", net_received: "净实收" } as const;
const moneyKeys = ["received", "refunded", "net_received"] as const;
const selectedMetric = "unprocessed";
type Metric = keyof typeof labels;
type Selection = {
  metric: Metric; clinic_ids: string[]; dentist_ids: string[]; date_from: string; date_to: string;
  comparison_date_from?: string; comparison_date_to?: string;
};
type Suggestion = { id: string; label: string; selection: Selection };
type Clinic = { clinic_id: string; name: string };
type AssistantOptions = { clinics: Clinic[]; suggestions: Suggestion[] };
type Rate = { numerator: number; denominator: number; value: string | null; availability: string };
type MoneyKey = keyof typeof moneyLabels;
type MoneyValues = Record<MoneyKey, string>;
type Row = { clinic_id: string | null; attendance_rate?: Rate; unprocessed?: Rate } & Partial<MoneyValues>;
type Period = { date_from: string; date_to: string; as_of: string; reference: string; metrics: Row[];
  scope: { clinic_ids: string[]; dentist_ids: string[] } };
type Change = { clinic_id: string | null; percentage_points?: string | null; availability?: "MISSING" | "NOT_APPLICABLE" } & Partial<MoneyValues>;
type Step = { id: "change_period" | "unprocessed_details" | "money_breakdown" | "report_rules"; label: string; period_index?: number };
type PendingAnalysis = { key: string; body?: Record<string, unknown>; prompt?: string };
type Result = {
  analysis_id: string; metric: Metric; mode: "template" | "deepseek"; model_status: string; as_of: string;
  date_from: string; date_to: string; scope: { clinic_ids: string[]; dentist_ids: string[] };
  periods: Period[]; comparison: { changes: Change[] } | null;
  observations: { id: string; text: string; source_id: string }[];
  questions: { id: string; text: string }[]; sources: { id: string; title: string; summary: string; version: string }[];
  next_steps: Step[];
};
export type AssistantDrilldown = { key: string; label: string };

function rateText(rate: Rate) {
  if (rate.availability === "MISSING") return "缺少数据";
  if (rate.value === null) return "不适用";
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(Number(rate.value));
}

function signedNumber(value: string) {
  return Number(value) > 0 ? "+" + value : value;
}

function reportWindow(period: Period) {
  return period.date_from + " 至 " + period.date_to;
}

function readPending(storageKey: string): PendingAnalysis | undefined {
  try {
    const key = sessionStorage.getItem(storageKey);
    return key && /^[a-f0-9-]{36}$/i.test(key) ? { key } : undefined;
  } catch {
    return undefined;
  }
}

export function AssistantPanel({ accountId, context, openOriginal, workspace = false, resetOriginal }: {
  accountId: string;
  context: string;
  workspace?: boolean;
  resetOriginal?: () => void;
  openOriginal: (reference: string, button: HTMLButtonElement, detail?: AssistantDrilldown) => void;
}) {
  const storageKey = "adc:operations-analysis:" + accountId;
  const [pending, setPending] = useState(() => readPending(storageKey));
  const [options, setOptions] = useState<AssistantOptions>();
  const [selection, setSelection] = useState<Selection>();
  const [result, setResult] = useState<Result>();
  const [turns,setTurns]=useState<{prompt:string; result:Result}[]>([]);
  const [currentPrompt,setCurrentPrompt]=useState("");
  const rangeDetails=useRef<HTMLDetailsElement>(null);
  const [question, setQuestion] = useState("");
  const [ask, setAsk] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [suggestionLoading, setSuggestionLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState("");
  const [retry, setRetry] = useState(0);
  const dateInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const analysisRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    request<AssistantOptions>(path + "/suggestions?" + context, { signal: controller.signal }).then(incoming => {
      if (controller.signal.aborted) return;
      setOptions(incoming);
      const initial = incoming.suggestions.find(item => item.id === selectedMetric) ?? incoming.suggestions[0];
      if (initial) setSelection(initial.selection);
    }).catch(error => {
      if (!controller.signal.aborted) setFault(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setSuggestionLoading(false);
    });
    return () => controller.abort();
  }, [context, retry]);
  useEffect(() => () => analysisRequest.current?.abort(), []);
  useEffect(() => { if (result && !workspace) resultHeading.current?.focus(); }, [result,workspace]);

  function choose(next: Selection) {
    setSelection(next);
    setAsk(false);
    setQuestion("");
    setComparing(Boolean(next.comparison_date_from));
  }

  function edit(change: Partial<Selection>) {
    setSelection(current => current && { ...current, ...change });
  }

  function clinicName(id: string | null) {
    return options?.clinics.find(clinic => clinic.clinic_id === id)?.name ?? id ?? "所选门店合计";
  }

  function remember(next?: PendingAnalysis) {
    try {
      if (next) sessionStorage.setItem(storageKey, next.key);
      else sessionStorage.removeItem(storageKey);
    } catch {
      // The current panel still holds the pending action when browser storage is unavailable.
    }
    setPending(next);
  }

  function analyze(event?: FormEvent) {
    event?.preventDefault();
    if (pending || analysisRequest.current || !selection || !options) return;
    if (!selection.clinic_ids.length) {
      setFault("请至少选择一家门店。");
      return;
    }
    if (!selection.date_from || !selection.date_to || selection.date_from > selection.date_to) {
      setFault("请核对本期起止日期。");
      return;
    }
    const { metric, clinic_ids, comparison_date_from, comparison_date_to, ...filters } = selection;
    const compareRequired=comparing && (ask || !["deposit_refund", "report_rules"].includes(metric));
    if (compareRequired && (!comparison_date_from || !comparison_date_to || comparison_date_from > comparison_date_to)) {
      setFault("请核对对比期起止日期。");
      return;
    }
    const comparison = compareRequired
      ? { comparison_date_from, comparison_date_to }
      : {};
    const body = {
      ...filters, ...comparison, ...(clinic_ids.length < options.clinics.length ? { clinic_ids } : {}),
      ...(ask ? { question:question.trim() } : { metric }),
    };
    const action = { key: crypto.randomUUID(), body, prompt:workspace ? question.trim() || labels[metric] : undefined };
    remember(action);
    void runAnalysis(action, false);
  }

  async function runAnalysis(action: PendingAnalysis, recover: boolean) {
    if (analysisRequest.current) return;
    const controller = new AbortController();
    analysisRequest.current = controller;
    const details = { actionKey: action.key, signal: controller.signal };
    setFault("");
    setBusy(true);
    if (workspace) setCurrentPrompt(action.prompt || "恢复原分析");
    try {
      let result: Result | undefined;
      if (recover) {
        try {
          result = await request<Result>(path + "/analysis/by-action", details);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404 && action.body)) throw error;
        }
      }
      const response = result ?? await request<Result>(path + "/analysis", { ...details, method: "POST", body: action.body });
      if (!controller.signal.aborted) {
        remember();
        setResult(response);
        if (workspace) {
          setQuestion("");
          setTurns(previous=>[...previous,{prompt:action.prompt || labels[response.metric],result:response}]);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const uncertain = error instanceof ApiError && (
        error.status === 0 || error.status >= 500 || ["RESULT_UNKNOWN", "RESULT_PENDING"].includes(error.error.code)
      );
      if (!uncertain) remember();
      setFault(error instanceof ApiError && error.error.code === "RESULT_UNKNOWN"
        ? "分析结果待核对。恢复连接后请核对原分析结果。"
        : errorMessage(error, "暂时无法分析，请重试。"));
    } finally {
      analysisRequest.current = null;
      if (!controller.signal.aborted) { setBusy(false); setCurrentPrompt(""); }
    }
  }

  function nextStep(step: Step, button: HTMLButtonElement, current: Result) {
    if (step.id === "change_period") {
      if (rangeDetails.current) rangeDetails.current.open=true;
      dateInput.current?.focus();
    }
    if (step.id === "report_rules" && selection) {
      choose({ ...selection, metric: "report_rules", comparison_date_from: undefined, comparison_date_to: undefined });
      if (workspace) setQuestion(labels.report_rules);
      dateInput.current?.focus();
    }
    const period = current.periods[step.period_index ?? 0];
    if (period && step.id === "unprocessed_details") openOriginal(period.reference, button, { key: "unprocessed", label: "到期未处置" });
    if (period && step.id === "money_breakdown") openOriginal(period.reference, button, { key: "net_received", label: "收退构成" });
  }

  const locked = busy || Boolean(pending);
  const fields = selection && options;
  const showComparison = selection && (ask || !["deposit_refund", "report_rules"].includes(selection.metric));
  const feedback = <>
    {suggestionLoading && <p role="status">正在读取可选问题…</p>}
    {fault && <p className="error-text" role="alert">{fault}</p>}
    {pending && <button className="button" disabled={busy} onClick={() => void runAnalysis(pending, true)}>核对原分析结果</button>}
    {!options && fault && <button className="button" onClick={() => {
      setFault(""); setSuggestionLoading(true); setRetry(value => value + 1);
    }}>重新读取建议</button>}
  </>;
  const filters = fields && selection &&       <form onSubmit={analyze}>
        {!workspace && <div className="schedule-tabs" aria-label="提问方式">
          <button type="button" className="button" aria-pressed={!ask} onClick={() => setAsk(false)} disabled={locked}>选择指标</button>
          <button type="button" className="button" aria-pressed={ask} onClick={() => setAsk(true)} disabled={locked}>中文提问</button>
        </div>}
        <div className="schedule-form">
          {workspace ? null : ask ? <label className="assistant-question">经营问题<input required maxLength={160} value={question} disabled={locked}
            placeholder="例如 查询本周与上周的实际就诊率" onChange={event => setQuestion(event.target.value)} /></label>
            : <label>分析指标<select value={selection.metric} disabled={locked} onChange={event => edit({ metric: event.target.value as Metric })}>
              {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>}
          <label>本期开始<input ref={dateInput} type="date" value={selection.date_from} required disabled={locked}
            onChange={event => edit({ date_from: event.target.value })} /></label>
          <label>本期结束<input type="date" value={selection.date_to} min={selection.date_from} required disabled={locked}
            onChange={event => edit({ date_to: event.target.value })} /></label>
        </div>
        <fieldset className="assistant-clinics" disabled={locked}>
          <legend>分析门店</legend>
          {fields.clinics.map(clinic => <label key={clinic.clinic_id}><input type="checkbox"
            checked={selection.clinic_ids.includes(clinic.clinic_id)} onChange={event => edit({
              clinic_ids: event.target.checked ? [...selection.clinic_ids, clinic.clinic_id]
                : selection.clinic_ids.filter(id => id !== clinic.clinic_id),
            })} />{clinic.name}</label>)}
        </fieldset>
        {selection.dentist_ids.length > 0 && <p className="muted">沿用报表牙医范围 {selection.dentist_ids.join("、")}。</p>}
        {showComparison && <div className="schedule-form">
          <label className="inline-control"><input type="checkbox" checked={comparing} disabled={locked}
            onChange={event => setComparing(event.target.checked)} />对比另一期间</label>
          {comparing && <>
            <label>对比期开始<input type="date" value={selection.comparison_date_from ?? ""} required disabled={locked}
              onChange={event => edit({ comparison_date_from: event.target.value })} /></label>
            <label>对比期结束<input type="date" value={selection.comparison_date_to ?? ""} required disabled={locked}
              min={selection.comparison_date_from} onChange={event => edit({ comparison_date_to: event.target.value })} /></label>
          </>}
        </div>}
        {!workspace && <button className="button primary" disabled={locked}>{busy ? "正在分析…" : "开始分析"}</button>}
      </form>;
  const suggestions = fields && selection && <div className={workspace ? "adc-agent-suggestions" : "assistant-suggestions"} aria-label="分析建议">
    {fields.suggestions.map(item => <button key={item.id} className="button" type="button" disabled={locked}
      onClick={() => {choose(item.selection); if(workspace) setQuestion(item.label);}}>{item.label}</button>)}
  </div>;

  function renderAnswer(result:Result) {
    return <div className="assistant-result" aria-labelledby={"assistant-result-" + result.analysis_id}>
      <h3 id={"assistant-result-" + result.analysis_id} ref={workspace ? undefined : resultHeading} tabIndex={-1}>{labels[result.metric]}分析</h3>
      <p className="muted">
        {result.mode === "deepseek" ? "DeepSeek 生成解读" : result.model_status === "limit_reached" ? "模型已达用量上限，显示报表解读"
          : result.model_status === "disabled" ? "显示报表解读" : "模型暂不可用，显示报表解读"}
        {" · "}统计截止 {dateTime(result.as_of)}
      </p>
      {result.periods.map((period, index) => <section className="assistant-period" key={period.reference}>
        <div className="schedule-heading">
          <h4>{index === 0 ? "本期" : "对比期"} · {reportWindow(period)}</h4>
          <button className="button" onClick={event => openOriginal(period.reference, event.currentTarget)}>查看原报表</button>
        </div>
        <p className="muted">{period.scope.clinic_ids.map(clinicName).join("、")}
          {period.scope.dentist_ids.length > 0 && " · 牙医 " + period.scope.dentist_ids.join("、")}</p>
        <div className="report-metrics">{period.metrics.map(row => {
          const rate = row.attendance_rate ?? row.unprocessed;
          return <div className="report-metric" key={row.clinic_id ?? "total"}>
            <span>{clinicName(row.clinic_id)}</span>
            {rate ? <>
              <strong>{rateText(rate)}</strong>
              <small>{rate.numerator}/{rate.denominator}{row.unprocessed ? " 笔到期未处置／分母" : ""}</small>
            </> : moneyKeys.map(key => <span key={key}>{moneyLabels[key]} {money(row[key])}</span>)}
          </div>;
        })}</div>
      </section>)}
      {result.comparison && <section aria-label="两期差异">
        <h4>两期差异</h4>
        <ul className="compact-list">{result.comparison.changes.map(change => <li key={change.clinic_id ?? "total"}>
          <strong>{clinicName(change.clinic_id)}</strong>
          {"percentage_points" in change ? <span>{change.percentage_points == null
            ? (change.availability === "MISSING" ? "缺少数据" : "不适用") : signedNumber(change.percentage_points) + " 个百分点"}</span>
            : moneyKeys.map(key => <span key={key}>{moneyLabels[key]} {signedNumber(change[key] ?? "0.00")} 元</span>)}
        </li>)}</ul>
      </section>}
      <ul className="compact-list">{result.observations.map(observation => <li key={observation.id}>
        {observation.text}{observation.source_id && <small className="muted">{observation.source_id}</small>}
      </li>)}</ul>
      {result.questions.length > 0 && <section aria-label="待核实的问题"><h4>待核实的问题</h4>
        <ul className="compact-list">{result.questions.map(item => <li key={item.id}>{item.text}</li>)}</ul>
      </section>}
      {result.sources.length > 0 && <details>
        <summary>统计与制度来源</summary>
        <ul className="compact-list">{result.sources.map(source => <li key={source.id}>
          <strong>{source.id} · {source.title}</strong><small className="muted">{source.version}</small>
          <span>{source.summary}</span>
        </li>)}</ul>
      </details>}
      {result.next_steps.length > 0 && <div className="assistant-suggestions" aria-label="后续操作">
        {result.next_steps.map(step => <button className="button" key={step.id} disabled={busy}
          onClick={event => nextStep(step, event.currentTarget, result)}>{step.label}</button>)}
      </div>}
    </div>;
  }

  if (workspace) return <AgentCanvas mode="授权经营报表" turnCount={turns.length} busy={busy}
    topAction={turns.length>0 ? <button type="button" disabled={locked} onClick={()=>{
      setTurns([]);setQuestion("");setFault("");setResult(undefined);resetOriginal?.();
    }}>新对话</button>:undefined}
    conversation={<>{turns.map(turn=><AgentTurn key={turn.result.analysis_id} prompt={turn.prompt}>
      {renderAnswer(turn.result)}</AgentTurn>)}{currentPrompt&&<p className="adc-agent-prompt">{currentPrompt}</p>}</>}
    suggestions={<>{feedback}{suggestions}{filters&&<details ref={rangeDetails} className="adc-agent-range">
      <summary>查看或调整分析范围</summary>{filters}</details>}</>}
    composer={<AgentComposer question={question} locked={locked||!fields} busy={busy} change={value=>{
      setQuestion(value);setAsk(true);
    }} submit={()=>analyze()}/>}/>;

  return <section id="operations-assistant" className="schedule-panel assistant-panel" aria-labelledby="assistant-title">
    <h2 id="assistant-title">经营分析助手</h2>
    {feedback}{suggestions}{filters}{result&&renderAnswer(result)}
  </section>;
}
