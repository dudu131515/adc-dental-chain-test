import { useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { WorkArea } from "../../shared/AppShell";
import { hasRole } from "../../shared/navigation";
import { dateTime } from "../../shared/format";
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

function Queue({ clinicId, open, invoicesOnly = false }: Pick<WorkArea, "clinicId" | "open"> & {invoicesOnly?:boolean}) {
  const [filter, setFilter] = useState("all");
  const [needle, setNeedle] = useState("");
  const read = useRead<{ items: BillingEntry[] }>("/billing/queue");
  const entries = read.data?.items.filter(row => (!clinicId || row.clinic_id === clinicId) && (
    invoicesOnly ? Boolean(row.invoice_id) && (row.invoice_no ?? "").toLowerCase().includes(needle.trim().toLowerCase())
      : filter === "all" || (filter === "unissued" ? !row.invoice_id : Boolean(row.invoice_id))
  )) ?? [];
  return <section className="schedule-panel">
    <div className="schedule-heading"><h2>{invoicesOnly ? "账单与收退" : "结算队列"}</h2>
      {invoicesOnly ? <label className="clinic-picker">按主单号查找<input type="search" value={needle}
        onChange={event=>setNeedle(event.target.value)} /></label> : <label className="clinic-picker">开单状态<select value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">全部</option><option value="unissued">待开单</option><option value="issued">已开单</option>
      </select></label>}
    </div>
    {read.loading && <p role="status">正在读取结算队列…</p>}
    {read.fault && <p role="alert" className="error-text">{read.fault}</p>}
    {read.data && !entries.length && <p>所选门店及状态暂无结算记录。</p>}
    {!!entries.length && <div className="schedule-scroll"><table className="report-table">
      <thead><tr>{["预约号", "结束时间", "就诊结果", "主单"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{entries.map(row => <tr key={row.visit_id}><th scope="row">{row.appointment_no}</th>
        <td>{dateTime(row.ended_at)}</td><td>{visitStates[row.status]}</td>
        <td><button className="text-action" onClick={() => open(row.invoice_id
          ? "/billing/invoices/" + row.invoice_id : "/billing/visits/" + row.visit_id)}>{row.invoice_no ?? "待开单"}</button></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

export function BillingPage({ identity, clinicId, path, open }: WorkArea) {
  const canBill = hasRole(identity, ["FRONT_DESK"], clinicId);
  const invoice = path.match(/^\/billing\/invoices\/(\d+)$/)?.[1];
  const issue = path.match(/^\/billing\/visits\/(\d+)$/)?.[1];
  if (invoice) return <InvoiceDetail key={invoice} id={invoice} accountId={identity.account_id} open={open} />;
  if (issue && canBill) return <IssueInvoice key={issue} id={issue} open={open} />;
  const corrections = path === "/billing/corrections" || !canBill;
  return <div className="operations-sections">
    <h1>结算</h1>
    {canBill && <div className="schedule-tabs" aria-label="结算页面">
      <button className="button" aria-pressed={!corrections} onClick={() => open("/billing")}>结算队列</button>
      <button className="button" aria-pressed={corrections} onClick={() => open("/billing/corrections")}>更正与审批</button>
    </div>}
    <div hidden={corrections}>{canBill && <Queue key={path==="/billing/invoices"?"invoices":"queue"}
      clinicId={clinicId} open={open} invoicesOnly={path==="/billing/invoices"} />}</div>
    {corrections && <CorrectionReview clinic={clinicId} open={open} />}
  </div>;
}
