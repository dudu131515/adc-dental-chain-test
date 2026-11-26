import { FormEvent, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import { dateTime, money } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { fundingStates } from "../schedule/appointmentTypes";
import { Invoice, Payment } from "./billingTypes";

type Outcome = { payment: Payment; invoice: Invoice };
type FundingDraft = {
  kind: "payments" | "refunds";
  key: string;
  fields: { amount: string; source_payment_id?: string; adjustment_id?: string };
};

function readDraft(storageKey: string) {
  if (!storageKey) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if ((value?.kind === "payments" || value?.kind === "refunds") &&
        typeof value.key === "string" && typeof value.fields?.amount === "string") {
      return value as FundingDraft;
    }
  } catch {
    // Keep the current page usable when browser storage is unavailable.
  }
  return null;
}
const cents = (amount?: string) => Math.round(Number(amount ?? 0) * 100);
const fromCents = (amount: number) => (amount / 100).toFixed(2);

export function InvoiceFunds({ invoice, accountId, onChange }: { invoice: Invoice; accountId?: string; onChange: () => void }) {
  const request = useApiRequest();
  const storageKey = accountId ? "adc:invoice-funding:" + accountId + ":" + invoice.invoice_id : "";
  const [draft, setDraft] = useState(() => readDraft(storageKey));
  const [selected, setSelected] = useState(draft?.fields.source_payment_id ?? "");
  const [payAmount, setPayAmount] = useState(draft?.kind === "payments" ? draft.fields.amount : "");
  const [refundAmount, setRefundAmount] = useState(draft?.kind === "refunds" ? draft.fields.amount : "");
  const [adjustment, setAdjustment] = useState(draft?.fields.adjustment_id ?? "");
  const [message, setMessage] = useState("");
  const action = useAction();
  const locked = action.busy || action.unknown || draft !== null;
  const base = "/invoices/" + invoice.invoice_id;
  const payments = invoice.payments ?? [];
  const originals = payments.filter(row => row.kind === "PAYMENT" && row.status === "SUCCEEDED");
  const original = originals.find(row => row.payment_id === selected);
  const refunds = payments.filter(row => row.kind === "REFUND" && row.source_payment_id === selected);
  const returned = refunds.filter(row => row.status === "SUCCEEDED").reduce((sum, row) => sum + cents(row.amount), 0);
  const pending = refunds.filter(row => row.status === "PENDING").reduce((sum, row) => sum + cents(row.amount), 0);
  const refundMax = Math.max(0, Math.min(cents(original?.amount) - returned - pending, cents(invoice.refund_due) - cents(invoice.pending_refund)));
  const collectionMax = Math.max(0, cents(invoice.outstanding) - cents(invoice.pending_collection));

  function recorded(result: Outcome) {
    setMessage((result.payment.kind === "REFUND" ? "诊疗退款 " : "诊疗收款 ") + result.payment.payment_id
      + " · " + fundingStates[result.payment.status]);
    setPayAmount(""); setRefundAmount("");
    onChange();
  }

  function remember(next: FundingDraft | null) {
    if (storageKey) {
      try {
        if (next) sessionStorage.setItem(storageKey, JSON.stringify(next));
        else sessionStorage.removeItem(storageKey);
      } catch {
        // The current page can still use its in-memory recovery state.
      }
    }
    setDraft(next);
  }

  function submit(next: FundingDraft, recover = false) {
    const endpoint = base + "/" + next.kind;
    action.execute<Outcome>(endpoint, next.fields, result => {
      remember(null);
      recorded(result);
    }, async actionKey => {
      try { return await request<Outcome>(endpoint + "/by-action", { actionKey }); }
      catch (error) {
        if (error instanceof ApiError && error.status === 404 && error.error.code === "NOT_FOUND") return undefined;
        // A failed lookup does not settle the original write.
        throw new ApiError(0, { code: "RESULT_UNKNOWN", message: "暂时无法核对原办理结果。" }, actionKey);
      }
    }, {
      actionKey: next.key, recover,
      onStart: recover ? undefined : () => remember(next),
      onRejection: () => remember(null),
    });
  }

  function collect(event: FormEvent) {
    event.preventDefault();
    if (!locked) submit({kind: "payments", key: crypto.randomUUID(), fields: {amount: payAmount}});
  }

  function refund(event: FormEvent) {
    event.preventDefault();
    if (!locked) submit({kind: "refunds", key: crypto.randomUUID(), fields: {
      source_payment_id: selected, amount: refundAmount, ...(adjustment ? { adjustment_id: adjustment } : {}),
    }});
  }

  function refundRetry(row: Payment) {
    action.execute<Outcome>(base + "/refunds/" + row.payment_id + "/retry", {}, recorded, async () => {
      const current = await request<Invoice>(base);
      const existing = current.payments?.find(item => item.payment_id === row.payment_id);
      return existing && existing.status !== "FAILED" ? { payment: existing, invoice: current } : undefined;
    });
  }

  return <section className="schedule-panel">
    <h2>诊疗收退</h2>
    <ActionFeedback {...action} />
    {draft && !action.busy && !action.unknown && <div>
      <p role="status">本主单有原收退办理待核对。</p>
      <button className="button" onClick={() => submit(draft, true)}>核对原办理结果</button>
    </div>}
    {message && <p role="status">{message}</p>}
    {invoice.allowed_actions.includes("collect") && <form className="schedule-form" onSubmit={collect}>
      <label>收款金额（元）<input disabled={locked} required type="number" min="0.01" max={fromCents(collectionMax)} step="0.01"
        value={payAmount} onChange={event => setPayAmount(event.target.value)} /></label>
      <button type="button" className="button" disabled={locked} onClick={() => setPayAmount(fromCents(collectionMax))}>填写全部可收金额</button>
      <button className="button primary" disabled={locked}>提交模拟收款</button>
    </form>}
    {invoice.allowed_actions.includes("refund") && <form className="schedule-form" onSubmit={refund}>
      <fieldset className="record-fields" disabled={locked}>
        <label>退款原收款<select required value={selected} onChange={event => { setSelected(event.target.value); setRefundAmount(""); }}>
          <option value="">选择同一主单的成功原收款</option>
          {originals.map(row => <option key={row.payment_id} value={row.payment_id}>
            记录 {row.payment_id} · {money(row.amount)} · {dateTime(row.paid_at)}
          </option>)}
        </select></label>
        <label>关联获批减额<select value={adjustment} onChange={event => setAdjustment(event.target.value)}>
          <option value="">按主单应退办理</option>{invoice.adjustments.filter(row => Number(row.signed_amount) < 0).map(row =>
            <option key={row.adjustment_id} value={row.adjustment_id}>差额 {row.adjustment_id} · {money(row.signed_amount)}</option>)}
        </select></label>
        <label>退款金额（元）<input required type="number" step="0.01" min="0.01" max={fromCents(refundMax)}
          value={refundAmount} onChange={event => setRefundAmount(event.target.value)} /></label>
      </fieldset>
      {original && <p>原收 {money(original.amount)} · 已退 {money(fromCents(returned))} · 在途 {money(fromCents(pending))}
        {" · "}本次最多可退 {money(fromCents(refundMax))}</p>}
      <button className="button primary" disabled={locked || refundMax === 0}>提交原路退款</button>
    </form>}
    <div className="schedule-heading"><h3>收退流水</h3><button className="button" disabled={locked} onClick={onChange}>核对资金结果</button></div>
    {payments.length ? <ul className="evidence-list">
      {payments.map(row => <li key={row.payment_id}>
        <span>{row.kind === "REFUND" ? "退款" : "收款"} {row.payment_id} · {money(row.amount)} · {fundingStates[row.status] ?? row.status}</span>
        {row.paid_at && <span> · {dateTime(row.paid_at)}</span>}
        {row.source_payment_id && <p>原收款 {row.source_payment_id}{row.adjustment_id && " · 获批差额 " + row.adjustment_id}</p>}
        {row.reconciliation_required ? <p className="error-text">回执待核对，退款已暂停。</p>
          : row.kind === "REFUND" && row.status === "FAILED" && <button className="button" disabled={locked} onClick={() => refundRetry(row)}>沿原退款重试</button>}
      </li>)}
    </ul> : <p>暂无诊疗收退记录。</p>}
  </section>;
}
