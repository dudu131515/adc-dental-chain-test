import { useState } from "react";
import { dateTime, money } from "../../shared/format";
import { useRead } from "../../shared/useRead";
import { fundingStates } from "../schedule/appointmentTypes";
import { CorrectionRequest, CorrectionReview } from "./CorrectionReview";
import { InvoiceFunds } from "./InvoiceFunds";
import { ReceiptPanel } from "./ReceiptPanel";
import { Invoice, invoiceStates } from "./billingTypes";

export function InvoiceDetail({ id, accountId, open }: { id: string; accountId: string; open: (path: string) => void }) {
  const [sequence, setSequence] = useState(0);
  const read = useRead<Invoice>("/invoices/" + id, sequence);
  const invoice = read.data;
  const refresh = () => setSequence(value => value + 1);

  return <div className="operations-sections">
    <div className="schedule-toolbar"><button className="button" onClick={() => open("/billing")}>返回结算</button></div>
    {read.loading && <p role="status">正在读取结算主单…</p>}
    {read.fault && <p className="error-text" role="alert">{read.fault}</p>}
    {invoice && <>
      <section className="schedule-panel">
        <div className="schedule-heading"><h1>{invoice.invoice_no}</h1>
          <span className="status-tag" data-state={invoice.status}>{invoiceStates[invoice.status]}</span>
          <ReceiptPanel invoice={invoice} />
        </div>
        <p>预约 {invoice.appointment_no} · 就诊 {invoice.visit_id} · 开立时间 {dateTime(invoice.issued_at)}</p>
        <dl className="inline-facts">
          <div><dt>原单金额</dt><dd>{money(invoice.original_total)}</dd></div>
          <div><dt>当前应计</dt><dd>{money(invoice.accrued)}</dd></div>
          {invoice.net_received !== undefined && <>
            <div><dt>净实收</dt><dd>{money(invoice.net_received)}</dd></div>
            <div><dt>欠款</dt><dd>{money(invoice.outstanding)}</dd></div>
            <div><dt>应退余额</dt><dd>{money(invoice.refund_due)}</dd></div>
          </>}
        </dl>
        {!invoice.lines.length && invoice.status === "SETTLED" && <p role="status">已结清 · 无需付款</p>}
      </section>
      <section className="schedule-panel">
        <h2>原始收费明细</h2>
        {invoice.lines.length ? <div className="schedule-scroll"><table className="report-table">
          <thead><tr>{["项目", "实际数量", "标准单位", "原单价", "小计"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{invoice.lines.map(row => <tr key={row.line_id}><th scope="row">{row.treatment_name}</th>
            <td>{row.units}</td><td>{row.unit}</td><td>{money(row.unit_price)}</td><td>{money(row.subtotal)}</td>
          </tr>)}</tbody>
        </table></div> : <p>没有实际治疗计费行。</p>}
        {!!invoice.adjustments.length && <>
          <h3>已入账差额</h3>
          <ul className="compact-list">{invoice.adjustments.map(row => <li key={row.adjustment_id}>
            差额 {row.adjustment_id} · 获批更正 {row.correction_id} · {money(row.signed_amount)}
          </li>)}</ul>
        </>}
      </section>
      {invoice.payments && <InvoiceFunds invoice={invoice} accountId={accountId} onChange={refresh} />}
      {invoice.deposit && <section className="schedule-panel">
        <h2>关联预约金</h2>
        <p>原预约金 {money(invoice.deposit.amount)} · {fundingStates[invoice.deposit.status]}</p>
        {invoice.deposit_refund && <p>预约金退款 {money(invoice.deposit_refund.amount)} · {fundingStates[invoice.deposit_refund.status]}</p>}
      </section>}
      {invoice.allowed_actions.includes("request_correction") && <CorrectionRequest invoice={invoice} onChange={refresh} />}
      <CorrectionReview open={open} invoice={id} change={sequence} onChange={refresh} />
    </>}
  </div>;
}
