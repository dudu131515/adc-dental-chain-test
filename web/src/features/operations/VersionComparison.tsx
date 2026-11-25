import { dateTime, money } from "../../shared/format";

export type Company = Record<"revenue" | "material_cost" | "operating_cost" | "net_profit" | "incentive_fund", string>;
export type Version = {
  period_id: string; revision_no: number; status: string; confirmed_at?: string; confirmed_by?: string;
  original_company?: Company; company?: Company; company_delta?: Company; unallocated_amount?: string;
  allowed_actions?: string[];
  review?: { decision: string; reason: string; reviewer_id: string };
  source?: { adjustment_id: string; invoice_id: string; visit_id: string; approver_id: string; signed_amount: string; approved_at: string };
  dentists?: { clinic_id: string; dentist_id: string; basis_minutes: string; revenue: string; material_cost: string; operating_cost: string; net_profit: string }[];
  visits?: { visit_id: string; clinic_id: string; dentist_id: string; ended_at: string; accrued: string; invoice_id: string | null;
    work_sessions: { work_id: string; dentist_id: string; minutes: string }[];
    materials: { usage_id: string; material_id: string; quantity: string; unit_cost: string }[] }[];
  expenses?: { expense_id: string; clinic_id: string; scope: string; category: string; amount: string; evidence_ref: string | null;
    unallocated_amount: string; allocations: { dentist_id: string; amount: string; basis_minutes: string | null }[] }[];
  missing?: { visit_id?: string; expense_id?: string; clinic_id: string; kind: string; message: string }[];
};

export const versionStates: Record<string, string> = {
  OPEN: "待核算", CALCULATING: "核算中", NEEDS_DATA: "待补证据", REVIEW: "待核对",
  CONFIRMED: "正式确认", PENDING: "待试算", RETURNED: "已退回待重算",
};

const metrics = [
  ["revenue", "应计收入"], ["material_cost", "实际耗材"], ["operating_cost", "运营费用"],
  ["net_profit", "净利润"], ["incentive_fund", "基金"],
] as const;

export function VersionComparison({ version, clinicName }: { version: Version; clinicName: (id: string) => string }) {
  return <div className="operations-sections">
    <section className="schedule-panel">
      <h2>第 {version.revision_no} 版 · {versionStates[version.status] ?? version.status}</h2>
      {version.confirmed_at && <p>确认于 {dateTime(version.confirmed_at)} · 确认人 {version.confirmed_by}</p>}
      {version.status !== "CONFIRMED" && <p>工作区版本，正式报表继续使用上一确认版。</p>}
      {version.review && <p>复核人 {version.review.reviewer_id} · {version.review.decision === "APPROVED" ? "通过" : "退回"} · {version.review.reason}</p>}
      {version.company && <div className="schedule-scroll"><table className="report-table">
        <thead><tr><th scope="col">公司指标</th><th scope="col">原版</th><th scope="col">与原版差额</th>
          <th scope="col">{version.status === "CONFIRMED" ? "本次确认值" : "本次试算值"}</th></tr></thead>
        <tbody>{metrics.map(([key, label]) => <tr key={key}><th scope="row">{label}</th>
          <td>{money(version.original_company?.[key])}</td><td>{money(version.company_delta?.[key])}</td>
          <td>{money(version.company?.[key])}</td></tr>)}</tbody>
      </table></div>}
      {version.unallocated_amount !== undefined && <p>运营费用未分配 {money(version.unallocated_amount)}</p>}
      {version.source && <dl className="inline-facts">
        <div><dt>差额凭证</dt><dd>{version.source.adjustment_id}</dd></div>
        <div><dt>原就诊与主单</dt><dd>{version.source.visit_id} / {version.source.invoice_id}</dd></div>
        <div><dt>本次应计差额</dt><dd>{money(version.source.signed_amount)}</dd></div>
        <div><dt>审批人及时间</dt><dd>{version.source.approver_id} · {dateTime(version.source.approved_at)}</dd></div>
      </dl>}
    </section>
    {!!version.missing?.length && <section className="schedule-panel">
      <h2>待补证据</h2><ul className="compact-list">{version.missing.map((row, index) => <li key={index}>
        {clinicName(row.clinic_id)} · {row.visit_id ? "就诊 " + row.visit_id : "费用 " + row.expense_id} · {row.message}
      </li>)}</ul>
    </section>}
    {!!version.dentists?.length && <section className="schedule-panel">
      <h2>牙医门店贡献</h2><div className="schedule-scroll"><table className="report-table">
        <thead><tr>{["门店", "牙医编号", "实际分钟", "应计", "耗材", "已分摊运营费", "净利润"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{version.dentists.map(row => <tr key={row.clinic_id + ":" + row.dentist_id}>
          <th scope="row">{clinicName(row.clinic_id)}</th><td>{row.dentist_id}</td><td>{row.basis_minutes}</td>
          <td>{money(row.revenue)}</td><td>{money(row.material_cost)}</td><td>{money(row.operating_cost)}</td><td>{money(row.net_profit)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    {!!version.expenses?.length && <section className="schedule-panel">
      <h2>费用与分摊依据</h2>
      <ul className="evidence-list">{version.expenses.map(row => <li key={row.expense_id}>
        <details><summary>{clinicName(row.clinic_id)} · {row.category} · {row.scope === "DIRECT" ? "直接费用" : "共同费用"}</summary>
          <p>费用 {money(row.amount)} · 未分配 {money(row.unallocated_amount)} · 凭据 {row.evidence_ref ?? "缺少数据"}</p>
          {row.allocations.length ? <ul>{row.allocations.map(part => <li key={part.dentist_id}>
            牙医 {part.dentist_id} · {money(part.amount)}{part.basis_minutes !== null && " · " + part.basis_minutes + " 分钟"}
          </li>)}</ul> : <p>当前费用没有分摊记录。</p>}
        </details>
      </li>)}</ul>
    </section>}
    {!!version.visits?.length && <section className="schedule-panel">
      <h2>就诊、计时与耗材依据</h2>
      <ul className="evidence-list">{version.visits.map(row => <li key={row.visit_id}>
        <details><summary>就诊 {row.visit_id} · {clinicName(row.clinic_id)} · {dateTime(row.ended_at)}</summary>
          <p>主单 {row.invoice_id ?? "缺少数据"} · 应计 {money(row.accrued)}</p>
          {row.work_sessions.map(work => <p key={work.work_id}>计时 {work.work_id} · 牙医 {work.dentist_id} · {work.minutes} 分钟</p>)}
          {row.materials.map(material => <p key={material.usage_id}>耗材 {material.material_id} · {material.quantity} × {money(material.unit_cost)}</p>)}
        </details>
      </li>)}</ul>
    </section>}
  </div>;
}
