import { dateTime, money } from "../../shared/format";
import { Invoice } from "./billingTypes";
import "./billing.css";

export function ReceiptPanel({ invoice }: { invoice: Invoice }) {
  if (invoice.net_received === undefined) return null;
  return <>
    <button className="button" onClick={() => window.print()}>打印结算凭据</button>
    <article className="invoice-issue-receipt" aria-label="打印用结算凭据">
      <h1>ADC 诊疗结算凭据</h1>
      <p>主单 {invoice.invoice_no} · 预约 {invoice.appointment_no} · 开单 {dateTime(invoice.issued_at)}</p>
      <table className="report-table">
        <thead><tr><th scope="col">原收费项目</th><th scope="col">数量和单位</th><th scope="col">单价</th><th scope="col">小计</th></tr></thead>
        <tbody>{invoice.lines.map(row => <tr key={row.line_id}><th scope="row">{row.treatment_name}</th>
          <td>{row.units} {row.unit}</td><td>{money(row.unit_price)}</td><td>{money(row.subtotal)}</td>
        </tr>)}</tbody>
      </table>
      <p>原始金额 {money(invoice.original_total)} · 当前应计 {money(invoice.accrued)}</p>
      <p>净实收 {money(invoice.net_received)} · 欠款 {money(invoice.outstanding)} · 应退 {money(invoice.refund_due)}</p>
      {invoice.deposit && <p>预约金另列 {money(invoice.deposit.amount)}
        {invoice.deposit_refund && " · 已登记退金 " + money(invoice.deposit_refund.amount)}
      </p>}
    </article>
  </>;
}
