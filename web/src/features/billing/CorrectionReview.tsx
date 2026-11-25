import { FormEvent, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { request } from "../../shared/api";
import { dateTime, money } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { Correction, Invoice, correctionStates } from "./billingTypes";

export function CorrectionRequest({ invoice, onChange }: { invoice: Invoice; onChange: () => void }) {
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  const [signed, setSigned] = useState("");
  const [recorded, setRecorded] = useState("");
  const action = useAction();
  const locked = action.busy || action.unknown;

  function submit(event: FormEvent) {
    event.preventDefault();
    action.execute<Correction>("/visits/" + invoice.visit_id + "/corrections", {
      invoice_id: invoice.invoice_id, reason, proposed_changes: { summary, signed_amount: signed },
    }, row => {
      setRecorded(row.correction_id);
      setSummary(""); setReason(""); setSigned("");
      onChange();
    });
  }
  return <section className="schedule-panel">
    <h2>提交同次就诊更正</h2>
    <p>原主单 {invoice.invoice_no} · 当前应计 {money(invoice.accrued)}</p>
    {recorded && <p role="status">更正 {recorded} 已提交，等待本店主管审批。</p>}
    <ActionFeedback {...action} />
    <form className="schedule-form" onSubmit={submit}>
      <fieldset className="record-fields" disabled={locked}>
        <label>拟更正内容<input required value={summary} onChange={event => setSummary(event.target.value)} /></label>
        <label>更正原因<input required value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label>有符号差额（元）<input required step="0.01" type="number" value={signed} onChange={event => setSigned(event.target.value)} /></label>
      </fieldset>
      <button className="button primary" disabled={locked}>提交更正</button>
    </form>
  </section>;
}

function CorrectionItem({ row, open, onChange }: {
  row: Correction; open: (path: string) => void; onChange: () => void;
}) {
  const [decision, setDecision] = useState("APPROVED");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const action = useAction();
  const locked = action.busy || action.unknown;
  const base = "/corrections/" + row.correction_id;
  const lookup = async (expected: string) => {
    const current = await request<{ items: Correction[] }>("/corrections");
    return current.items.find(entry => entry.correction_id === row.correction_id && entry.status === expected);
  };
  return <li>
    <div className="schedule-heading">
      <strong>更正 {row.correction_id} · {correctionStates[row.status]}</strong>
      <button className="text-action" onClick={() => open("/billing/invoices/" + row.invoice_id)}>查看原主单</button>
    </div>
    <p>就诊 {row.visit_id} · 拟更正 {money(row.proposed_amount)} · {dateTime(row.requested_at)}</p>
    {row.summary && <p>{row.summary}</p>}{row.reason && <p>原因 {row.reason}</p>}
    {row.approval && <p>审批人 {row.approval.reviewer_id} · {dateTime(row.approval.decided_at)}{row.approval.reason && " · " + row.approval.reason}</p>}
    {row.approval?.approved_signed_amount && <p>获批差额 {money(row.approval.approved_signed_amount)}</p>}
    <ActionFeedback {...action} />
    {row.allowed_actions.includes("decide") && <form className="schedule-form" onSubmit={event => {
      event.preventDefault();
      action.execute<Correction>(base + "/decision", { decision, reason,
        ...(decision === "APPROVED" && amount !== "" ? { approved_signed_amount: amount } : {}),
      }, onChange, () => lookup(decision));
    }}>
      <fieldset className="record-fields" disabled={locked}>
        <label>审批结论<select value={decision} onChange={event => setDecision(event.target.value)}>
          <option value="APPROVED">批准</option><option value="REJECTED">拒绝</option>
        </select></label>
        <label>审批意见<input required value={reason} onChange={event => setReason(event.target.value)} /></label>
        {decision === "APPROVED" && <label>批准差额（元）<input type="number" step="0.01" placeholder={row.proposed_amount}
          value={amount} onChange={event => setAmount(event.target.value)} /></label>}
      </fieldset>
      <button className="button primary" disabled={locked}>保存审批</button>
    </form>}
    {row.allowed_actions.includes("apply") && <button className="button primary" disabled={locked}
      onClick={() => action.execute(base + "/apply", { invoice_id: row.invoice_id }, onChange, () => lookup("APPLIED"))}>
      入账获批差额
    </button>}
  </li>;
}

export function CorrectionReview({ clinic, invoice, change = 0, open, onChange }: {
  clinic?: string; invoice?: string; change?: number;
  open: (path: string) => void; onChange?: () => void;
}) {
  const [sequence, setSequence] = useState(0);
  const read = useRead<{ items: Correction[] }>("/corrections", change + sequence);
  const items = read.data?.items.filter(row => (!clinic || row.clinic_id === clinic) && (!invoice || row.invoice_id === invoice)) ?? [];
  return <section className="schedule-panel">
    <h2>更正与审批</h2>
    {read.loading && <p role="status">正在读取更正记录…</p>}
    {read.fault && <p className="error-text" role="alert">{read.fault}</p>}
    {read.data && !items.length && <p>当前范围没有更正记录。</p>}
    <ul className="evidence-list">{items.map(row => <CorrectionItem key={row.correction_id} row={row} open={open} onChange={() => {
      setSequence(value => value + 1); onChange?.();
    }} />)}</ul>
  </section>;
}
