import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { FormEvent, useEffect, useRef, useState } from "react";
import { StaffIdentity } from "../../shared/AppShell";
import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import { errorMessage } from "../../shared/format";
import { Period } from "./ExpensesPage";
import { Version, VersionComparison, versionStates } from "./VersionComparison";

type PeriodDetail = Period & { latest_confirmed?: Version; workspace?: Version; allowed_actions: string[] };
type Action = { path: string; body?: unknown; key: string; verify?: (row: Version) => boolean; revisionPath?: string };
const base = "/performance/periods";

export function QuarterReview({ identity, periodId, open }: {
  identity: StaffIdentity; periodId?: string; open: (path: string) => void;
}) {
  const { workday } = useWorkspaceRuntime();
  const request = useApiRequest();
  const canCalculate = identity.capabilities.includes("HQ_PERFORMANCE_CALCULATE");
  const today = workday.split("-").map(Number);
  const [year, setYear] = useState(today[0]);
  const [quarter, setQuarter] = useState(Math.ceil(today[1] / 3));
  const [items, setItems] = useState<Period[]>([]);
  const [period, setPeriod] = useState<PeriodDetail>();
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<number>();
  const [sequence, reload] = useState(0);
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState("APPROVED");
  const [fault, setFault] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const action = useRef<Action | undefined>(undefined);
  const clinicName = (id: string) => identity.clinics.find(row => row.clinic_id === id)?.name ?? id;

  useEffect(() => { setSelected(undefined); setFault(""); setMessage(""); action.current = undefined; }, [periodId]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const signal = controller.signal;
    const read = async () => {
      if (!periodId) {
        const result = await request<{ items: Period[] }>(base, { signal });
        if (!signal.aborted) setItems(result.items);
        return;
      }
      const [current, history] = await Promise.all([
        request<PeriodDetail>(base + "/" + periodId, { signal }),
        request<{ items: Version[] }>(base + "/" + periodId + "/revisions", { signal }),
      ]);
      if (!signal.aborted) { setPeriod(current); setVersions(history.items); }
    };
    read().catch(error => { if (!signal.aborted) setFault(errorMessage(error)); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [periodId, sequence]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setFault("");
    try {
      const result = await request<Period>(base, { method: "POST", body: { year, quarter } });
      open("/operations/quarters/" + result.period_id);
    } catch (error) { setFault(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function execute(next?: Omit<Action, "key">) {
    const existing = action.current;
    if (!existing && next) action.current = { ...next, key: crypto.randomUUID() };
    const current = action.current;
    if (!current) return;
    setBusy(true); setFault(""); setMessage("");
    try {
      let found: Version | undefined;
      if (existing && current.revisionPath && current.verify) {
        const result = await request<Version>(current.revisionPath);
        if (current.verify(result)) found = result;
      }
      if (!found) found = await request<Version>(current.path, {
        method: "POST", body: current.body, actionKey: current.key,
      });
      action.current = undefined;
      setMessage("第 " + found.revision_no + " 版 · " + (versionStates[found.status] ?? found.status));
      setSelected(found.revision_no);
      reload(value => value + 1);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 0) action.current = undefined;
      setFault(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const shownPeriod = period?.period_id === periodId ? period : undefined;
  const version = shownPeriod && (versions.find(row => row.revision_no === selected) ?? shownPeriod.latest_confirmed ?? shownPeriod.workspace);
  const versionPath = version ? base + "/" + periodId + "/revisions/" + version.revision_no : "";
  const retry = action.current !== undefined;

  return <div className="operations-sections">
    {fault && <p className="error-text" role="alert">{fault}</p>}
    {message && <p role="status">{message}</p>}
    {loading && <p role="status">正在读取季度核算…</p>}
    {!periodId && <section className="schedule-panel">
      <h2>季度核算</h2>
      {canCalculate && <form className="schedule-form" onSubmit={create}>
        <label>年份<input type="number" required min={2020} max={9998} value={year}
          onChange={event => setYear(Number(event.target.value))} /></label>
        <label>季度<select value={quarter} onChange={event => setQuarter(Number(event.target.value))}>
          {[1, 2, 3, 4].map(value => <option key={value} value={value}>第 {value} 季度</option>)}
        </select></label>
        <button className="button primary" disabled={busy}>打开核算期间</button>
      </form>}
      {!!items.length && <div className="schedule-scroll"><table className="report-table">
        <thead><tr><th scope="col">核算期间</th><th scope="col">当前状态</th><th scope="col">最新已确认版本</th></tr></thead>
        <tbody>{items.map(row => <tr key={row.period_id}>
          <th scope="row"><button className="text-action" onClick={() => open("/operations/quarters/" + row.period_id)}>
            {row.year} 年第 {row.quarter} 季度
          </button></th>
          <td><span className="status-tag" data-state={row.status}>{row.status ? versionStates[row.status] ?? row.status : "—"}</span></td>
          <td>{row.latest_confirmed_revision_no ? "正式第 " + row.latest_confirmed_revision_no + " 版" : "尚未确认"}</td>
        </tr>)}</tbody>
      </table></div>}
      {!loading && !items.length && <p>当前范围暂无季度。</p>}
    </section>}
    {shownPeriod && <section className="schedule-panel">
      <div className="schedule-heading">
        <h2>{shownPeriod.year} 年第 {shownPeriod.quarter} 季度</h2>
        <button className="button" onClick={() => open("/operations/quarters")}>返回季度列表</button>
      </div>
      <p>{shownPeriod.latest_confirmed
        ? "最新正式结果为第 " + shownPeriod.latest_confirmed.revision_no + " 版"
        : "当前季度尚未正式确认。"}</p>
      {shownPeriod.workspace && <p>工作区第 {shownPeriod.workspace.revision_no} 版 · {versionStates[shownPeriod.workspace.status]}</p>}
      <div className="schedule-toolbar">
        {!!versions.length && <label className="clinic-picker">查看版本<select value={version?.revision_no ?? ""}
          disabled={busy || retry} onChange={event => setSelected(Number(event.target.value))}>
          {versions.map(row => <option key={row.revision_no} value={row.revision_no}>
            第 {row.revision_no} 版 · {versionStates[row.status]}
          </option>)}
        </select></label>}
        {shownPeriod.allowed_actions.includes("calculate") && <button className="button primary" disabled={busy || retry}
          onClick={() => execute({ path: base + "/" + periodId + "/calculate" })}>运行试算</button>}
        {retry && <button className="button primary" disabled={busy} onClick={() => execute()}>核对原办理结果</button>}
      </div>
    </section>}
    {version && <>
      <VersionComparison version={version} clinicName={clinicName} />
      {version.allowed_actions?.includes("review") && <section className="schedule-panel">
        <h2>复核试算</h2>
        <form className="schedule-form" onSubmit={event => {
          event.preventDefault();
          void execute({ path: versionPath + "/review", body: { decision, reason }, revisionPath: versionPath,
            verify: row => row.review?.decision === decision && row.review.reason === reason });
        }}>
          <label>复核结果<select disabled={busy || retry} value={decision} onChange={event => setDecision(event.target.value)}>
            <option value="APPROVED">通过</option><option value="REJECTED">退回重算</option>
          </select></label>
          <label>复核理由<input required disabled={busy || retry} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <button className="button primary" disabled={busy || retry}>提交复核</button>
        </form>
      </section>}
      {version.allowed_actions?.includes("confirm") && <section className="schedule-panel">
        <h2>确认季度版本</h2>
        <p>确认后冻结第 {version.revision_no} 版依据和结果，正式报表采用该版。</p>
        <button className="button primary" disabled={busy || retry} onClick={() => execute({
          path: versionPath + "/confirm", revisionPath: versionPath, verify: row => row.status === "CONFIRMED",
        })}>确认第 {version.revision_no} 版</button>
      </section>}
    </>}
  </div>;
}
