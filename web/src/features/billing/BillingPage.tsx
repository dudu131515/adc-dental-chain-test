import { useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { WorkArea } from "../../shared/AppShell";
import { hasRole } from "../../shared/navigation";
import { dateTime, money } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { Visit, visitStates } from "../clinical/clinicalTypes";
import { CorrectionReview } from "./CorrectionReview";
import { InvoiceDetail } from "./InvoiceDetail";
import { BillingEntry, Invoice } from "./billingTypes";

function IssueInvoice({ id, open }: { id: string; open: (path: string) => void }) {
  const action = useAction();
  const read = useRead<Visit>("/visits/" + id);
  return <section className="schedule-panel">
    <div className="schedule-heading"><h1>开立结算主单</h1><button className="button" onClick={() => open("/billing")}>返回队列</button></div>
    {read.loading && <p role="status">正在读取结算交接…</p>}
    {read.fault && <p role="alert" className="error-text">{read.fault}</p>}
    <ActionFeedback {...action} />
    {read.data && <>
      <p>预约 {read.data.appointment_no} · 就诊 {id} · {visitStates[read.data.status]}</p>
      <ul className="compact-list">{read.data.treatment_items.map(row => <li key={row.item_id}>{row.name} · {row.units} {row.unit}</li>)}</ul>
      {!read.data.treatment_items.length && read.data.status === "TERMINATED" && <p>中止前未实施治疗，开立零额已结清主单。</p>}
      {read.data.can_issue_invoice ? <button className="button primary" disabled={action.busy || action.unknown}
        onClick={() => action.execute<Invoice>("/visits/" + id + "/invoice", {}, invoice => open("/billing/invoices/" + invoice.invoice_id))}>
        生成或查看唯一主单
      </button> : <p role="status">{read.data.status === "IN_PROGRESS" ? "就诊结束后才能开立主单。" : "该就诊须由本店授权前台开单。"}</p>}
    </>}
  </section>;
}

const billingStates = {
  WAITING_INVOICE: "待开单", WAITING_PAYMENT: "待收款", PARTIAL_PAYMENT: "部分收款",
  SETTLED: "已结清", REFUND_DUE: "待退款", REFUND_PENDING: "退款处理中",
} as const;

type QueueFilters = { text: string; status: string; cursors: (string | null)[] };
export const emptyFilters: QueueFilters = { text: "", status: "", cursors: [null] };

export function BillingQueue({ clinicId, open, filters, update, invoicesOnly }: Pick<WorkArea, "clinicId" | "open"> & {
  invoicesOnly: boolean; filters: QueueFilters; update: (filters: QueueFilters) => void;
}) {
  const [text, setText] = useState(filters.text);
  const [status, setStatus] = useState(filters.status);
  const [revision, setRevision] = useState(0);
  const query = new URLSearchParams();
  if (clinicId) query.set("clinic_id", clinicId);
  if (filters.status || invoicesOnly) query.set("status", filters.status || "INVOICED");
  const cursor = filters.cursors.at(-1);
  if (cursor) query.set("cursor", cursor);
  const read = useRead<{ items: BillingEntry[]; next_cursor: string | null }>(
    "/billing/queue" + (query.size ? "?" + query : ""), revision, { queueSearch: filters.text },
  );
  const rows = read.data?.items ?? [];
  return <section className="schedule-panel">
    <div className="schedule-heading"><h2>{invoicesOnly ? "账单与收退" : "结算队列"}</h2></div>
    <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      update({ text: text.trim(), status, cursors: [null] });
      setRevision(value => value + 1);
    }}>
      <label>搜索结算记录<input type="search" value={text} maxLength={150}
        placeholder="患者姓名、完整手机号、预约号或主单号" onChange={event => setText(event.target.value)} /></label>
      <label>办理状态<select value={status} onChange={event => setStatus(event.target.value)}>
        <option value="">{invoicesOnly ? "全部账单" : "全部状态"}</option>
        {Object.entries(billingStates).filter(([key]) => !invoicesOnly || key !== "WAITING_INVOICE").map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}
      </select></label>
      <button className="button primary">搜索</button>
      <button className="button" type="button" onClick={() => {
        setText(""); setStatus(""); update(emptyFilters); setRevision(value => value + 1);
      }}>清除筛选</button>
    </form>
    {read.loading && <p role="status">正在读取结算队列…</p>}
    {read.fault && <div role="alert">
      <p className="error-text">{read.fault}</p>
      <button className="button" onClick={() => { update({ ...filters, cursors: [null] }); setRevision(value => value + 1); }}>重新查询</button>
    </div>}
    {read.data && !rows.length && <p>当前门店与筛选条件下没有结算记录。</p>}
    {!!rows.length && <div className="schedule-scroll"><table className="report-table">
      <thead><tr>{["患者", "预约及门店", "就诊结束", "办理状态", "待办金额", "主单"].map(label =>
        <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.visit_id}>
        <th scope="row">{row.patient_display.name}
          {row.patient_display.phone_tail && <><br/><small className="muted">尾号 {row.patient_display.phone_tail}</small></>}
        </th>
        <td>{row.appointment_no}<br/><small className="muted">{row.clinic_name}</small></td>
        <td>{dateTime(row.ended_at)}</td>
        <td><span className="status-tag">{billingStates[row.billing_state]}</span></td>
        <td>{row.billing_state === "REFUND_PENDING" || row.billing_state === "REFUND_DUE" ? <>
          {Number(row.pending_refund) > 0 && <div>处理中 {money(row.pending_refund)}</div>}
          {Number(row.refund_remaining) > 0 && <div>待退 {money(row.refund_remaining)}</div>}
        </> : row.outstanding !== null ? money(row.outstanding) : "—"}</td>
        <td><button className="text-action" aria-label={row.invoice_no ? "查看 " + row.invoice_no : undefined} onClick={() => open(row.invoice_id
          ? "/billing/invoices/" + row.invoice_id : "/billing/visits/" + row.visit_id)}>{row.invoice_no ?? "开立主单"}</button></td>
      </tr>)}</tbody>
    </table></div>}
    {read.data && (filters.cursors.length > 1 || read.data.next_cursor) && <nav className="schedule-toolbar" aria-label="结算队列分页">
      <button className="button" disabled={filters.cursors.length < 2}
        onClick={() => update({ ...filters, cursors: filters.cursors.slice(0, -1) })}>上一页</button>
      <span>第 {filters.cursors.length} 页</span>
      <button className="button" disabled={!read.data.next_cursor}
        onClick={() => update({ ...filters, cursors: [...filters.cursors, read.data?.next_cursor ?? null] })}>下一页</button>
    </nav>}
  </section>;
}

export function BillingPage({ identity, clinicId, path, open }: WorkArea) {
  const canBill = hasRole(identity, ["FRONT_DESK"], clinicId);
  const [queueFilters, setQueueFilters] = useState(emptyFilters);
  const [invoiceFilters, setInvoiceFilters] = useState(emptyFilters);
  const [returnTo, setReturnTo] = useState("/billing");
  const invoice = path.match(/^\/billing\/invoices\/([\w-]+)$/)?.[1];
  const issue = path.match(/^\/billing\/visits\/([\w-]+)$/)?.[1];
  if (invoice) return <InvoiceDetail key={invoice} id={invoice} accountId={identity.account_id} open={open} returnTo={returnTo} />;
  if (issue && canBill) return <IssueInvoice key={issue} id={issue} open={open} />;
  const corrections = path === "/billing/corrections" || !canBill;
  const invoices = path === "/billing/invoices";
  return <div className="operations-sections">
    <h1>结算</h1>
    {corrections ? <CorrectionReview clinic={clinicId} open={open} />
      : <BillingQueue key={path} clinicId={clinicId} open={destination => { setReturnTo(path); open(destination); }}
        invoicesOnly={invoices} filters={invoices ? invoiceFilters : queueFilters}
        update={invoices ? setInvoiceFilters : setQueueFilters} />}
  </div>;
}
