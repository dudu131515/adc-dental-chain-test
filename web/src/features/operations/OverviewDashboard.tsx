import { useState } from "react";
import { money } from "../../shared/format";
import type { ClinicMetric, Rate, Report } from "./operationsTypes";
import { TrendChart, type TrendSeries } from "./TrendChart";

const percentage = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function percent(rate?: Rate) {
  if (!rate) return "—";
  if (rate.availability === "MISSING") return "缺少数据";
  if (rate.value === null) return "不适用";
  return percentage.format(Number(rate.value));
}

function hours(minutes?: string) {
  return ((Number(minutes) || 0) / 60).toFixed(1);
}

const financeSeries: TrendSeries[] = [
  { key: "revenue", label: "营业收入", color: "#1c6b5b", format: "money" },
  { key: "material_cost", label: "诊疗成本", color: "#c47b3a", format: "money" },
  { key: "operating_cost", label: "经营费用", color: "#7d6aa8", format: "money" },
  { key: "net_profit", label: "净利润", color: "#2f7fb5", format: "money" },
];
const volumeSeries: TrendSeries[] = [
  { key: "appointments", label: "预约数量", color: "#7d6aa8", format: "count" },
  { key: "attended", label: "实际就诊", color: "#1c6b5b", format: "count" },
  { key: "visits", label: "完成就诊", color: "#2f7fb5", format: "count" },
];
const workloadSeries: TrendSeries[] = [
  { key: "work_minutes", label: "牙医实际工时", color: "#1c6b5b", format: "minutes" },
];

const views = [
  { id: "finance", label: "收支与利润", series: financeSeries },
  { id: "volume", label: "预约与就诊", series: volumeSeries },
  { id: "workload", label: "牙医工时", series: workloadSeries },
] as const;

function clinicBarWidth(value: number, maximum: number) {
  return maximum > 0 ? Math.max(2, (value / maximum) * 100) + "%" : "0%";
}

export function OverviewDashboard({ report, onDetail, onCompare }: {
  report: Report;
  onDetail: (metric: string, label: string, clinic?: string) => void;
  onCompare: () => void;
}) {
  const [view, setView] = useState<(typeof views)[number]["id"]>("finance");
  const operations = report.operations;
  const resources = report.resources;
  const clinics = report.clinics ?? [];
  const workload = report.workload;
  if (!operations) return null;
  const active = views.find(item => item.id === view) ?? views[0];
  const maxClinicRevenue = Math.max(1, ...clinics.map(row => Number(row.revenue)));
  const maxHours = Math.max(1, ...(workload?.dentists ?? []).map(row => Number(row.hours)));
  const expenseTotal = operations.expense_categories.reduce((sum, row) => sum + Number(row.amount), 0);
  const costTotal = Number(operations.material_cost) + Number(operations.operating_cost);
  return <div className="ops-overview">
    <div className="ops-kpi-grid" aria-label="经营关键指标">
      <button className="ops-kpi" data-tone="revenue" onClick={() => onDetail("revenue", "营业收入")}>
        <span>营业收入</span><strong>{money(operations.revenue)}</strong>
        <small>净实收 {money(operations.net_received)}</small>
      </button>
      <button className="ops-kpi" data-tone="cost" onClick={() => onDetail("material_cost", "诊疗成本")}>
        <span>诊疗成本</span><strong>{money(operations.material_cost)}</strong>
        <small>{Number(operations.revenue) > 0 ? "占收入 " + percentage.format(Number(operations.material_cost) / Number(operations.revenue)) : "暂无收入基数"}</small>
      </button>
      <button className="ops-kpi" data-tone="expense" onClick={() => onDetail("operating_cost", "经营费用")}>
        <span>经营费用</span><strong>{money(operations.operating_cost)}</strong>
        <small>{operations.expense_periods.length ? "按登记季度日数摊入" : "所选期间无登记费用"}</small>
      </button>
      <button className="ops-kpi" data-tone="profit" onClick={() => onDetail("net_profit", "净利润")}>
        <span>净利润</span><strong>{money(operations.net_profit)}</strong>
        <small>利润率 {percent(operations.profit_margin)}</small>
      </button>
      <button className="ops-kpi" data-tone="appointments" onClick={() => onDetail("attended", "已履约预约")}>
        <span>预约数量</span><strong>{report.appointments.denominator}</strong>
        <small>已履约 {report.appointments.attended} 笔 · 履约率 {percent(report.appointments.attendance_rate)}</small>
      </button>
      <button className="ops-kpi" data-tone="visits" onClick={() => onDetail("actual_starts", "就诊数量")}>
        <span>就诊数量</span><strong>{report.clinical.actual_starts}</strong>
        <small>正常完成 {report.clinical.normal_completions} 次</small>
      </button>
      <button className="ops-kpi" data-tone="workload" onClick={() => onDetail("workload", "牙医工作量")}>
        <span>牙医工作量</span><strong>{workload ? workload.total_hours : hours(resources?.dentist_work_minutes)} <em>小时</em></strong>
        <small>{workload?.dentists.length ?? 0} 名牙医 · 实际计时</small>
      </button>
      <button className="ops-kpi" data-tone="resource" onClick={() => onDetail("chair_utilization", "资源利用")}>
        <span>诊椅时段利用率</span><strong>{percent(resources?.chair_utilization)}</strong>
        <small>{resources ? resources.active_chairs + " 台牙椅 · " + resources.open_chair_days + " 个开放日" : "缺少排班依据"}</small>
      </button>
    </div>

    <section className="schedule-panel ops-trend-panel">
      <div className="schedule-heading">
        <div><h2>经营趋势</h2><p className="muted">按业务发生日期汇总，收入与成本口径与经营明细一致。</p></div>
        <label className="clinic-picker">趋势视图<select value={view} onChange={event => setView(event.target.value as typeof view)}>
          {views.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
      </div>
      <TrendChart points={report.trend?.points ?? []} series={[...active.series]} />
      {report.trend?.granularity === "month" && <p className="muted">统计区间较长，趋势按自然月汇总。</p>}
    </section>

    <div className="ops-split">
      <section className="schedule-panel">
        <div className="schedule-heading"><h2>资源利用</h2>
          <button className="text-action" onClick={() => onDetail("chair_utilization", "诊椅利用")}>查看诊椅明细</button></div>
        <div className="ops-meters">
          <div className="ops-meter-row">
            <span>诊椅时段利用率</span><strong>{percent(resources?.chair_utilization)}</strong>
            <div className="ops-meter"><i style={{ width: percent(resources?.chair_utilization) === "—" ? "0%" : Math.min(100, Number(resources?.chair_utilization.value ?? 0) * 100) + "%" }} /></div>
            <small>{resources ? Number(resources.chair_occupied_minutes).toFixed(0) + " / " + Number(resources.chair_capacity_minutes).toFixed(0) + " 分钟" : "缺少依据"}</small>
          </div>
          <div className="ops-meter-row">
            <span>牙医时段利用率</span><strong>{percent(resources?.dentist_utilization)}</strong>
            <div className="ops-meter"><i style={{ width: Math.min(100, Number(resources?.dentist_utilization.value ?? 0) * 100) + "%" }} /></div>
            <small>{resources ? Number(resources.dentist_booked_minutes).toFixed(0) + " / " + Number(resources.dentist_shift_minutes).toFixed(0) + " 分钟" : "缺少依据"}</small>
          </div>
          <div className="ops-meter-row">
            <span>实际工时占排班</span><strong>{percent(resources?.work_utilization)}</strong>
            <div className="ops-meter"><i style={{ width: Math.min(100, Number(resources?.work_utilization.value ?? 0) * 100) + "%" }} /></div>
            <small>{resources ? Number(resources.dentist_work_minutes).toFixed(0) + " 分钟实际计时" : "缺少依据"}</small>
          </div>
        </div>
      </section>

      <section className="schedule-panel">
        <div className="schedule-heading"><h2>成本与费用结构</h2>
          <button className="text-action" onClick={() => onDetail("operating_cost", "经营费用")}>查看费用明细</button></div>
        {costTotal > 0 ? <div className="ops-cost-stack" aria-label="成本与费用构成">
          <span className="ops-cost-material" style={{ flexGrow: Number(operations.material_cost) || 0.01 }}
            title={"诊疗成本 " + money(operations.material_cost)} />
          <span className="ops-cost-expense" style={{ flexGrow: Number(operations.operating_cost) || 0.01 }}
            title={"经营费用 " + money(operations.operating_cost)} />
        </div> : <p className="muted">所选期间尚未产生诊疗成本与经营费用。</p>}
        <dl className="ops-cost-legend">
          <div><dt><i className="ops-dot material" />诊疗成本</dt><dd>{money(operations.material_cost)}</dd></div>
          <div><dt><i className="ops-dot expense" />经营费用</dt><dd>{money(operations.operating_cost)}</dd></div>
          <div><dt>成本合计</dt><dd>{money(costTotal.toFixed(2))}</dd></div>
        </dl>
        {!!operations.expense_categories.length && <ul className="ops-category-list">
          {operations.expense_categories.map(row => <li key={row.category}>
            <span>{row.category}</span>
            <div aria-hidden="true"><i style={{ width: expenseTotal > 0 ? (Number(row.amount) / expenseTotal) * 100 + "%" : "0%" }} /></div>
            <strong>{money(row.amount)}</strong>
          </li>)}
        </ul>}
      </section>
    </div>

    <section className="schedule-panel">
      <div className="schedule-heading">
        <div><h2>门店经营一览</h2><p className="muted">收入、成本、利润与资源效率按同一期间对比。</p></div>
        <button className="button" onClick={onCompare}>进入门店对比</button>
      </div>
      <div className="schedule-scroll"><table className="report-table ops-clinic-table">
        <thead><tr>
          {["门店", "营业收入", "净实收", "诊疗成本", "经营费用", "净利润", "就诊", "履约率", "牙医工时", "诊椅利用"].map(label => <th scope="col" key={label}>{label}</th>)}
        </tr></thead>
        <tbody>{clinics.map((row: ClinicMetric) => <tr key={row.clinic_id}>
          <th scope="row">{row.clinic_name}</th>
          <td>{money(row.revenue)}</td><td>{money(row.net_received)}</td><td>{money(row.material_cost)}</td>
          <td>{money(row.operating_cost)}</td><td className={Number(row.net_profit) < 0 ? "ops-negative" : "ops-positive"}>{money(row.net_profit)}</td>
          <td>{row.visits}</td><td>{percent(row.attendance_rate)}</td><td>{row.work_hours} 小时</td><td>{percent(row.chair_utilization)}</td>
        </tr>)}</tbody>
      </table></div>
      {!clinics.length && <p>所选范围没有可汇总的门店。</p>}
      <div className="ops-clinic-bars">{clinics.map(row => <div key={row.clinic_id} className="ops-clinic-bar">
        <span>{row.clinic_name}</span>
        <div aria-hidden="true"><i style={{ width: clinicBarWidth(Number(row.revenue), maxClinicRevenue) }} /></div>
        <strong>{money(row.revenue)}</strong>
      </div>)}</div>
    </section>

    <section className="schedule-panel">
      <div className="schedule-heading">
        <div><h2>牙医工作量与贡献</h2><p className="muted">按实际计时分钟排序，收入与耗材按主诊牙医归属。</p></div>
        <button className="text-action" onClick={() => onDetail("workload", "牙医工作量")}>查看计时明细</button>
      </div>
      {workload?.dentists.length ? <div className="ops-workload-list">{workload.dentists.map(row => <article key={row.clinic_id + ":" + row.dentist_id}>
        <header><strong>{row.dentist_name}</strong><small>{row.clinic_name}</small></header>
        <div className="ops-workload-bar" aria-hidden="true"><i style={{ width: clinicBarWidth(Number(row.hours), maxHours) }} /></div>
        <dl>
          <div><dt>实际工时</dt><dd>{row.hours} 小时</dd></div>
          <div><dt>接诊</dt><dd>{row.visits} 次</dd></div>
          <div><dt>诊疗项目</dt><dd>{row.treatments} 项</dd></div>
          <div><dt>诊疗收入</dt><dd>{money(row.revenue)}</dd></div>
        </dl>
      </article>)}</div> : <p>所选期间没有牙医计时记录。</p>}
    </section>
  </div>;
}
