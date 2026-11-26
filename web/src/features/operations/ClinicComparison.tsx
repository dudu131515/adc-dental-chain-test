import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { type FormEvent, useEffect, useState } from "react";
import { useApiRequest } from "../../shared/ApiTransport";
import { dateTime, errorMessage, money } from "../../shared/format";
import { canWorkAt, type StaffIdentity } from "../../shared/navigation";
import type { Report } from "./operationsTypes";

type Range = { from: string; to: string };
type MetricId = "revenue" | "net" | "visits" | "attendance" | "material" | "operating" | "profit" | "workload" | "chair";
type Row = { clinic: StaffIdentity["clinics"][number]; before: Report; current: Report };
const percentage = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const oneDecimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const previousDay = (value: string, offset: number) => new Date(new Date(value + "T00:00:00Z").valueOf() - offset * 86400000).toISOString().slice(0, 10);

const metrics: { id: MetricId; label: string; group: string }[] = [
  { id: "revenue", label: "营业收入", group: "收入" },
  { id: "net", label: "诊疗净实收", group: "收入" },
  { id: "visits", label: "就诊数量", group: "业务量" },
  { id: "attendance", label: "预约履约率", group: "业务量" },
  { id: "material", label: "诊疗成本", group: "成本" },
  { id: "operating", label: "经营费用", group: "成本" },
  { id: "profit", label: "净利润", group: "利润" },
  { id: "workload", label: "牙医工作量", group: "资源" },
  { id: "chair", label: "诊椅利用率", group: "资源" },
];

function valueOf(report: Report, metric: MetricId): number | null {
  const operations = report.operations;
  const resources = report.resources;
  if (metric === "revenue") return Number(operations?.revenue ?? report.financial.accrued);
  if (metric === "net") return Number(report.financial.net_received);
  if (metric === "visits") return report.clinical.actual_starts;
  if (metric === "attendance") {
    return report.appointments.denominator ? report.appointments.attended / report.appointments.denominator : null;
  }
  if (metric === "material") return Number(operations?.material_cost ?? 0);
  if (metric === "operating") return Number(operations?.operating_cost ?? 0);
  if (metric === "profit") return Number(operations?.net_profit ?? 0);
  if (metric === "workload") {
    if (report.workload) return Number(report.workload.total_hours);
    if (resources) return Number(resources.dentist_work_minutes) / 60;
    return null;
  }
  if (metric === "chair") return resources?.chair_utilization.value == null ? null : Number(resources.chair_utilization.value);
  return null;
}

function format(value: number | null, metric: MetricId) {
  if (value === null) return "不适用";
  if (metric === "attendance" || metric === "chair") return percentage.format(value);
  if (metric === "visits") return oneDecimal.format(value) + " 次";
  if (metric === "workload") return oneDecimal.format(value) + " 小时";
  return money(value.toFixed(2));
}

function diff(now: number | null, old: number | null, metric: MetricId) {
  if (now === null || old === null) return "不可比";
  const delta = now - old;
  if (delta === 0) return "持平";
  const signed = delta > 0 ? "+" : "−";
  if (metric === "attendance" || metric === "chair") return signed + oneDecimal.format(Math.abs(delta) * 100) + " 个百分点";
  return signed + format(Math.abs(delta), metric);
}

function query(range: Range, clinic: string) {
  return new URLSearchParams({ date_from: range.from, date_to: range.to, clinic_ids: clinic });
}

export function ClinicComparison({ identity, open, initial }: {
  identity: StaffIdentity; open: (path: string) => void;
  initial?: { current: Range; before: Range };
}) {
  const { workday } = useWorkspaceRuntime();
  const request = useApiRequest();
  const [clinics] = useState(() => identity.clinics.filter(branch => canWorkAt(identity, "HQ_OPERATIONS_QUERY", branch.clinic_id)));
  const [selected, setSelected] = useState(() => clinics.map(branch => branch.clinic_id));
  const [metric, setMetric] = useState<MetricId>("revenue");
  const [ranges, setRanges] = useState(() => {
    const end = workday;
    return initial ?? { current: { from: previousDay(end, 6), to: end }, before: { from: previousDay(end, 13), to: previousDay(end, 7) } };
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [fault, setFault] = useState("");
  const [criteria, setCriteria] = useState(() => ({ ranges, selected }));
  const [detail, setDetail] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    setLoading(true);
    setFault("");
    setRows([]);
    setDetail(undefined);
    Promise.all(clinics.filter(branch => criteria.selected.includes(branch.clinic_id)).map(async clinic => {
      const [before, current] = await Promise.all([
        request<Report>("/reports/operations?" + query(criteria.ranges.before, clinic.clinic_id), { signal }),
        request<Report>("/reports/operations?" + query(criteria.ranges.current, clinic.clinic_id), { signal }),
      ]);
      return { clinic, before, current };
    })).then(result => { if (!signal.aborted) setRows(result); })
      .catch(error => { if (!signal.aborted) setFault(errorMessage(error)); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [criteria, clinics, request]);
  function compare(event: FormEvent) {
    event.preventDefault();
    if (!selected.length) { setFault("请至少选择一家门店。"); return; }
    if (ranges.current.from > ranges.current.to || ranges.before.from > ranges.before.to) {
      setFault("请核对两个期间的起止日期。"); return;
    }
    setCriteria({ ranges, selected });
  }
  const shown = rows.find(row => row.clinic.clinic_id === detail);
  const selectedMetric = metrics.find(item => item.id === metric) ?? metrics[0];
  const maximum = Math.max(1, ...rows.flatMap(row => [row.before, row.current].map(report => Math.abs(valueOf(report, metric) ?? 0))));
  return <div className="operations-sections adc-comparison">
    <section className="schedule-panel ops-filter-panel">
      <div className="schedule-heading"><div><h2>跨门店经营对比</h2><p className="muted">对照同口径的两个期间，比较门店的收入、成本、效率与利润。</p></div></div>
      <form className="schedule-form" onSubmit={compare}>
        {(["current", "before"] as const).flatMap(side => (["from", "to"] as const).map(field =>
          <label key={side + field}>{(side === "current" ? "本期" : "对比期") + (field === "from" ? "开始" : "结束")}
            <input type="date" required value={ranges[side][field]} onChange={event => {
              const value = event.target.value;
              setRanges(old => ({ ...old, [side]: { ...old[side], [field]: value } }));
            }} /></label>))}
        <fieldset className="adc-compare-branches"><legend>参与比较的门店</legend>
          {clinics.map(branch => <label key={branch.clinic_id}><input type="checkbox"
            checked={selected.includes(branch.clinic_id)} onChange={event => setSelected(old => event.target.checked
              ? [...old, branch.clinic_id] : old.filter(id => id !== branch.clinic_id))} />{branch.name}</label>)}
        </fieldset>
        <button className="button primary" disabled={loading || !clinics.length}>应用对比</button>
      </form>
      {fault && <p className="error-text" role="alert">{fault}</p>}
    </section>
    {loading && <p role="status">正在读取两期经营数据…</p>}
    {!loading && !!rows.length && <>
      <section className="schedule-panel" aria-label="门店对比结果">
        <div className="schedule-heading"><div><h2>重点指标对比</h2><p className="muted">
          {criteria.ranges.before.from} 至 {criteria.ranges.before.to} → {criteria.ranges.current.from} 至 {criteria.ranges.current.to}</p></div>
          <label>对比指标 <select value={metric} onChange={event => setMetric(event.target.value as MetricId)}>
            {metrics.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
        <div className="adc-comparison-grid">{rows.map(row => {
          const before = valueOf(row.before, metric), current = valueOf(row.current, metric);
          return <article key={row.clinic.clinic_id} className="adc-comparison-store">
            <h3>{row.clinic.name}</h3>
            {[{ label: "对比期", value: before }, { label: "本期", value: current }].map(({ label, value }) =>
              <div className="adc-compare-bar" key={label}>
                <span>{label}</span><div aria-hidden="true"><i style={{ width: Math.abs(value ?? 0) * 100 / maximum + "%" }} /></div>
                <strong>{format(value, metric)}</strong></div>)}
            <footer><strong className={(current ?? 0) - (before ?? 0) >= 0 ? "ops-positive" : "ops-negative"}>{diff(current, before, metric)}</strong>
              <button className="button" aria-expanded={detail === row.clinic.clinic_id}
                onClick={() => setDetail(detail === row.clinic.clinic_id ? undefined : row.clinic.clinic_id)}>
                {detail === row.clinic.clinic_id ? "收起口径" : "查看口径与报表"}</button></footer>
          </article>;
        })}</div>
      </section>
      <section className="schedule-panel">
        <div className="schedule-heading"><div><h2>本期指标对照表</h2><p className="muted">括注为相对对比期的变化，便于快速定位差异。</p></div></div>
        <div className="schedule-scroll"><table className="report-table adc-compare-table">
          <thead><tr><th scope="col">指标</th>{rows.map(row => <th scope="col" key={row.clinic.clinic_id}>{row.clinic.name}</th>)}</tr></thead>
          <tbody>{metrics.map(item => <tr key={item.id}>
            <th scope="row">{item.label}<small className="adc-metric-group">{item.group}</small></th>
            {rows.map(row => {
              const current = valueOf(row.current, item.id), before = valueOf(row.before, item.id);
              return <td key={row.clinic.clinic_id}><strong className={item.id === "profit" && (current ?? 0) < 0 ? "ops-negative" : undefined}>{format(current, item.id)}</strong>
                <small className={(current ?? 0) - (before ?? 0) >= 0 ? "ops-positive" : "ops-negative"}>{diff(current, before, item.id)}</small></td>;
            })}
          </tr>)}</tbody>
        </table></div>
      </section>
      <section className="schedule-panel">
        <h2>本期经营排名</h2>
        <div className="adc-ranking">
          {(["revenue", "net", "profit", "attendance", "chair"] as MetricId[]).map(item => {
            const ranked = [...rows].sort((left, right) => (valueOf(right.current, item) ?? -Infinity) - (valueOf(left.current, item) ?? -Infinity));
            const label = metrics.find(metricRow => metricRow.id === item)?.label ?? item;
            return <div key={item} className="adc-ranking-row"><span>{label}</span>
              <ol>{ranked.map((row, index) => <li key={row.clinic.clinic_id}><i>{index + 1}</i>{row.clinic.name}
                <strong>{format(valueOf(row.current, item), item)}</strong></li>)}</ol></div>;
          })}
        </div>
      </section>
    </>}
    {!clinics.length && <p>当前账号没有可比较的授权门店。</p>}
    {shown && <section className="schedule-panel">
      <h2>{shown.clinic.name} · 指标口径</h2>
      <div className="schedule-scroll"><table className="report-table">
        <thead><tr>{["统计期间", "接诊 / 正式预约", "到期未处置", "已核实爽约", "应计收入", "净实收", "经营费用", "净利润", "统计截止", "报表"].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{([{ report: shown.before, range: criteria.ranges.before, label: "对比期" }, { report: shown.current, range: criteria.ranges.current, label: "本期" }]).map(({ report, range, label }) => <tr key={label}>
          <th scope="row">{label}</th><td>{report.appointments.attended} / {report.appointments.denominator}</td>
          <td>{report.appointments.unprocessed}</td><td>{report.appointments.no_show}</td>
          <td>{money(report.financial.accrued)}</td><td>{money(report.financial.net_received)}</td>
          <td>{money(report.operations?.operating_cost ?? "0.00")}</td><td>{money(report.operations?.net_profit ?? "0.00")}</td>
          <td>{dateTime(report.as_of)}</td>
          <td><button className="text-action" onClick={() => open("/operations/report?" + query(range, shown.clinic.clinic_id))}>打开{label}报表</button></td></tr>)}</tbody>
      </table></div>
    </section>}
  </div>;
}
