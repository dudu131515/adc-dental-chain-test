import { useEffect, useRef, useState } from "react";
import { useApiRequest } from "../../shared/ApiTransport";
import { dateTime, errorMessage } from "../../shared/format";

const labels: Record<string, string> = {
  appointment_no: "预约编号", status: "状态", service_date: "预约日期", slot_end_at: "时段结束",
  visit_id: "就诊编号", dentist_id: "牙医编号", clinic_id: "门店编号", occurred_at: "发生时间",
  treatment_code: "项目编码", treatment_name: "计费项目", units: "实际数量", unit: "单位", unit_price: "标准单价",
  matches_standard: "匹配标准", invoice_no: "主单编号", invoice_id: "主单记录号", payment_id: "资金记录号",
  accrued: "应计", outstanding: "欠款", paid_at: "资金时间", amount: "金额", kind: "收退类型",
  qualification_code: "资格编码", qualification_name: "资格", period_id: "季度编号", revision_no: "确认版本",
  revenue: "应计", material_cost: "耗材", operating_cost: "运营费用", net_profit: "净利润",
  dentist: "牙医", scope: "费用归属", attributed: "已归属", unallocated: "未分配",
  clinic_name: "门店", dentist_name: "牙医", material_name: "耗材", quantity: "数量", unit_cost: "单位成本",
  recorded_amount: "登记金额", expense_category: "费用类别", period: "期间", work_id: "计时编号",
  minutes: "分钟", active_chairs: "可用牙椅", capacity_minutes: "可用分钟",
  occupied_minutes: "占用分钟", utilization: "利用率",
};
const statuses: Record<string, string> = {
  CONFIRMED: "已确认", CHECKED_IN: "已签到", IN_TREATMENT: "诊疗中", COMPLETED: "已完成", CANCELLED: "已取消",
  NO_SHOW: "已核实爽约", TERMINATED: "已中止", IN_PROGRESS: "诊疗中", PAYMENT: "收款", REFUND: "退款",
  DIRECT: "直接", SHARED: "共同",
};
type Row = Record<string, string | number | boolean>;
type DetailPage = { as_of: string; items: Row[]; next_cursor: string | null; total: number };

function valueLabel(key: string, value: Row[string]) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" && key.endsWith("_at")) return dateTime(value);
  return statuses[String(value)] ?? String(value);
}

export function ReportDetails({ token, metric, label, clinic, onClose }: {
  token: string; metric: string; label: string; clinic?: string; onClose: () => void;
}) {
  const request = useApiRequest();
  const [page, setPage] = useState<DetailPage>();
  const [fault, setFault] = useState("");
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ report_token: token, metric });
    if (clinic) query.set("clinic_id", clinic);
    if (cursor) query.set("cursor", cursor);
    setLoading(true);
    setFault("");
    request<DetailPage>("/reports/operations/details?" + query, { signal: controller.signal }).then(next => {
      if (controller.signal.aborted) return;
      setPage(next);
    }).catch(error => {
      if (!controller.signal.aborted) setFault(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [token, metric, clinic, cursor, request]);
  return <aside className="schedule-drawer" aria-label={label + "明细"} onKeyDown={event => {
    if (event.key === "Escape") onClose();
  }}>
    <div className="schedule-heading"><h2>{label}明细</h2><button className="button" ref={close} onClick={onClose}>关闭明细</button></div>
    {loading && <p role="status">正在读取同次查询明细…</p>}
    {fault && <p className="error-text" role="alert">{fault}</p>}
    {!loading && !fault && page && <>
      <p className="muted">统计截止 {dateTime(page.as_of)} · 共 {page.total} 条</p>
      {!page.items.length && <p>当前范围没有明细。</p>}
      <ol className="report-detail-list">{page.items.map((row, index) => <li key={index}>
        <dl>{Object.entries(row).filter(([key]) => labels[key]).map(([key, value]) => <div key={key}>
          <dt>{labels[key]}</dt><dd>{valueLabel(key, value)}</dd>
        </div>)}</dl>
      </li>)}</ol>
      {cursor && <button className="button" onClick={() => setCursor("")}>回到第一页</button>}
      {page.next_cursor && <button className="button" onClick={() => setCursor(page.next_cursor ?? "")}>下一页</button>}
    </>}
  </aside>;
}
