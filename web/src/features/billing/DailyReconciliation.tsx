import { useEffect, useState } from "react";
import type { WorkArea } from "../../shared/AppShell";
import { dateTime, localDay, money } from "../../shared/format";
import { hasRole } from "../../shared/navigation";
import { useRead } from "../../shared/useRead";
import { HandoverEvidence } from "../schedule/HandoverEvidence";
import type { Payment } from "./billingTypes";

const roles = ["FRONT_DESK", "CLINIC_MANAGER"];
const kindLabels = {
  DEPOSIT_PAYMENT: "预约金收款", DEPOSIT_REFUND: "预约金退款",
  TREATMENT_PAYMENT: "诊疗收款", TREATMENT_REFUND: "诊疗退款", TREATMENT_REFUND_DUE: "诊疗应退余额",
};
const statusLabels: Record<string, string> = {
  PAID: "已实收", SUCCEEDED: "已成功", PENDING: "在途", RETAINED: "已留存", FAILED: "退款失败", DUE: "待办理",
};
const reasonLabels: Record<string, string> = {
  PATIENT_CANCELLATION: "患者原因取消", CLINIC_CANCELLATION: "诊所原因取消",
  NO_SHOW: "爽约", UNCONFIRMED_APPOINTMENT: "预约未转正", VISIT_STARTED: "开始就诊",
};
type Fund = {
  id: string | null; kind: keyof typeof kindLabels; clinic_id: string; status: string; amount: string;
  requested_at: string | null; receipt_at: string | null; cross_day: boolean | null;
  reason: string | null; retained_amount: string | null; claim_id?: string; deposit_id?: string; source_payment_id?: string;
  source: { kind: "appointment" | "handover" | "invoice"; id: string }
    | { kind: "payment"; invoice_id: string; id: string } | null;
};
type Reconciliation = {
  clinic_id: string; clinic_name: string; date: string; as_of: string; historical: boolean;
  totals: Record<"deposit_received" | "deposit_refunded" | "deposit_net" |
    "treatment_received" | "treatment_refunded" | "treatment_net", string>;
  settled: Fund[]; pending: Fund[]; retained: Fund[]; refund_due: Fund[];
};

function PaymentEvidence({ invoiceId, paymentId }: { invoiceId: string; paymentId: string }) {
  const read = useRead<Payment>("/invoices/" + invoiceId + "/payments/" + paymentId);
  const payment = read.loading || read.fault ? undefined : read.data;
  return <div className="appointment-action">
    {read.loading && <p role="status">正在读取流水…</p>}
    {read.fault && <p className="error-text" role="alert">{read.fault}</p>}
    {payment && <>
      <p>{payment.kind === "REFUND" ? "诊疗退款" : "诊疗收款"} {payment.payment_id} · {statusLabels[payment.status]}</p>
      <dl className="inline-facts">
        <div><dt>流水金额</dt><dd>{money(payment.amount)}</dd></div>
        {payment.paid_at && <div><dt>成功回执</dt><dd>{dateTime(payment.paid_at)}</dd></div>}
        {payment.source_payment_id && <div><dt>原收款</dt><dd>{payment.source_payment_id}</dd></div>}
      </dl>
    </>}
  </div>;
}

function FundSource({ source, open }: { source: Fund["source"]; open: WorkArea["open"] }) {
  const [expanded, setExpanded] = useState(false);
  if (!source) return null;
  if (source.kind === "handover") return <>
    <button className="text-action" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>核对原店交接</button>
    {expanded && <HandoverEvidence id={source.id} />}
  </>;
  if (source.kind === "payment") return <>
    <button className="text-action" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>核对流水</button>
    {expanded && <PaymentEvidence invoiceId={source.invoice_id} paymentId={source.id} />}
  </>;
  const invoice = source.kind === "invoice";
  const path = invoice ? "/billing/invoices/" : "/schedule/appointments/";
  return <button className="text-action" onClick={() => open(path + source.id)}>{invoice ? "查看主单" : "查看预约"}</button>;
}

function FundTable({ title, records, empty, note, open }: {
  title: string; records: Fund[]; empty: string; note?: string; open: WorkArea["open"];
}) {
  return <section className="schedule-panel">
    <h2>{title}</h2>
    {note && <p>{note}</p>}
    {records.length ? <div className="schedule-scroll" role="region" aria-label={title + "明细"} tabIndex={0}>
      <table className="report-table">
        <thead><tr>{["资金类型与编号", "金额", "状态", "首次发起", "成功回执", "关联证据"]
          .map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{records.map((row, index) => <tr key={row.id ? row.kind + ":" + row.id : "due:" + index}>
          <th scope="row">{kindLabels[row.kind]}{row.id && " " + row.id}</th>
          <td>{money(row.retained_amount && row.status === "RETAINED" ? row.retained_amount : row.amount)}</td>
          <td>{statusLabels[row.status]}</td>
          <td>{row.requested_at ? dateTime(row.requested_at) : row.status === "DUE" ? "—" : "发起时间待核实"}
            {row.status === "PENDING" && row.cross_day && <div>跨日</div>}
          </td>
          <td>{dateTime(row.receipt_at)}</td>
          <td>
            {row.claim_id && <div>原占位 {row.claim_id}</div>}
            {row.deposit_id && <div>原预约金 {row.deposit_id}</div>}
            {row.source_payment_id && <div>诊疗原收款 {row.source_payment_id}</div>}
            {row.reason && <div>{reasonLabels[row.reason]}</div>}
            {row.retained_amount && row.status === "SUCCEEDED" && <div>留存 {money(row.retained_amount)}</div>}
            <FundSource source={row.source} open={open} />
          </td>
        </tr>)}</tbody>
      </table>
    </div> : <p>{empty}</p>}
  </section>;
}

export function DailyReconciliation({ identity, clinicId, path, open }: WorkArea) {
  const clinics = identity.clinics.filter(clinic => hasRole(identity, roles, clinic.clinic_id));
  const [selectedClinic, setClinic] = useState(() => new URLSearchParams(window.location.search).get("clinic_id") ?? "");
  const [date, setDate] = useState(() => new URLSearchParams(window.location.search).get("date") ?? localDay());
  const [refresh, setRefresh] = useState(0);
  const activeClinic = clinicId
    ? clinics.find(clinic => clinic.clinic_id === clinicId)
    : clinics.find(clinic => clinic.clinic_id === selectedClinic) ?? clinics[0];
  const activeClinicId = activeClinic?.clinic_id;
  const query = activeClinicId && date ? new URLSearchParams({ clinic_id: activeClinicId, date }).toString() : null;
  useEffect(() => {
    if (window.location.pathname !== path) return;
    const filters = new URLSearchParams(window.location.search);
    if (activeClinicId) filters.set("clinic_id", activeClinicId);
    else filters.delete("clinic_id");
    if (date) filters.set("date", date);
    else filters.delete("date");
    const search = filters.size ? "?" + filters.toString() : "";
    if (search !== window.location.search) {
      window.history.replaceState(window.history.state, "", path + search + window.location.hash);
    }
  }, [activeClinicId, date, path]);
  const read = useRead<Reconciliation>(query ? "/billing/reconciliation?" + query : undefined, refresh);
  const result = read.loading || read.fault ? undefined : read.data;
  return <div className="operations-sections">
    <section className="schedule-panel">
      <h1>日结对账</h1>
      {!activeClinic ? <p role="status">当前范围没有可查询的门店。</p> : <div className="schedule-form">
        <label className="clinic-picker">对账门店<select value={activeClinic.clinic_id} onChange={event => setClinic(event.target.value)}
          disabled={Boolean(clinicId)}>{clinics.map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>
          {clinic.name}
        </option>)}</select></label>
        <label className="clinic-picker">营业日期<input type="date" value={date} max={localDay()}
          onChange={event => setDate(event.target.value)} /></label>
        <button className="button" disabled={!query || read.loading} onClick={() => setRefresh(value => value + 1)}>重新查询</button>
      </div>}
      {activeClinic && !date && <p role="status">请选择营业日期。</p>}
      {read.loading && <p role="status">正在读取日结对账…</p>}
      {read.fault && <p role="alert" className="error-text">{read.fault}</p>}
      {result && <p>{result.clinic_name} · {result.date} · 查询截止 {dateTime(result.as_of)}</p>}
    </section>
    {result && <>
      <section className="schedule-panel">
        <h2>成功资金汇总</h2>
        <div className="schedule-scroll"><table className="report-table">
          <thead><tr><th scope="col">资金分类</th><th scope="col">实收</th><th scope="col">已退</th><th scope="col">净额</th></tr></thead>
          <tbody>
            <tr><th scope="row">预约金</th><td>{money(result.totals.deposit_received)}</td>
              <td>{money(result.totals.deposit_refunded)}</td><td>{money(result.totals.deposit_net)}</td></tr>
            <tr><th scope="row">诊疗款</th><td>{money(result.totals.treatment_received)}</td>
              <td>{money(result.totals.treatment_refunded)}</td><td>{money(result.totals.treatment_net)}</td></tr>
          </tbody>
        </table></div>
      </section>
      <FundTable title="营业日成功回执" records={result.settled} empty="所选营业日没有成功回执。" open={open} />
      <FundTable title="当前在途" records={result.pending} empty="查询截止时没有在途资金。" open={open}
        note={result.historical ? "当前为历史营业日。未决义务按本次查询截止读取。" : "未决义务按本次查询截止读取。"} />
      <FundTable title="应退待处理" records={result.refund_due} empty="查询截止时没有待处理退款。" open={open}
        note="按本次查询截止读取。诊疗应退余额已扣除在途退款。" />
      <FundTable title="预约金留存" records={result.retained} empty="所选营业日没有留存记录。" open={open} />
    </>}
  </div>;
}
