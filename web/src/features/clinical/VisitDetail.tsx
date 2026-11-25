import { FormEvent, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { request } from "../../shared/api";
import { dateTime, money } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { fundingStates } from "../schedule/appointmentTypes";
import { ClinicalContext, Visit, visitStates } from "./clinicalTypes";
import { PatientContext } from "./PatientContext";
import { AllergyHistory } from "./AllergyReview";
import { TreatmentForm } from "./TreatmentForm";
import "./clinical.css";

export function VisitDetail({ id, open }: { id: string; open: (target: string) => void }) {
  const [sequence, setSequence] = useState(0);
  const base = "/visits/" + id;
  const read = useRead<Visit>(base, sequence);
  const current = read.data;
  const ongoing = current?.status === "IN_PROGRESS";
  const context = useRead<ClinicalContext>(ongoing && current.main_dentist_id ? "/appointments/" + current.appointment_id + "/clinical-context" : undefined, sequence);
  const [notes, setNotes] = useState("");
  const [ending, setEnding] = useState<"finish" | "terminate">("finish");
  const [reason, setReason] = useState("");
  const action = useAction();

  function close(event: FormEvent) {
    event.preventDefault();
    const expected = ending === "finish" ? "COMPLETED" : "TERMINATED";
    action.execute<Visit>(base + "/" + ending, {
      clinical_notes: notes, ...(ending === "terminate" ? { reason } : {}),
    }, () => setSequence(value => value + 1), async () => {
      const latest = await request<Visit>(base);
      return latest.status === expected ? latest : undefined;
    });
  }

  return <div className="operations-sections">
    <div className="schedule-toolbar"><button className="button" onClick={() => open("/clinical")}>返回接诊队列</button></div>
    {read.loading && <p role="status">正在读取诊疗详情…</p>}
    {read.fault && <p className="error-text" role="alert">{read.fault}</p>}
    {current && !current.main_dentist_id && <p role="alert">仅负责本次就诊的牙医可查看诊疗详情。</p>}
    {current?.main_dentist_id && <>
      <section className="schedule-panel">
        <div className="schedule-heading"><h1>{current.patient_display?.name ?? "诊疗详情"}</h1>
          <span className="status-tag" data-state={current.status}>{visitStates[current.status]}</span></div>
        <dl className="inline-facts">
          <div><dt>预约号</dt><dd>{current.appointment_no}</dd></div>
          <div><dt>门店</dt><dd>{current.clinic_name}</dd></div>
          <div><dt>责任牙医</dt><dd>{current.dentist_name}</dd></div>
          <div><dt>牙椅</dt><dd>{current.chair?.chair_no ?? "已释放"}</dd></div>
          <div><dt>实际开始</dt><dd>{dateTime(current.started_at)}</dd></div>
          {current.ended_at && <div><dt>实际结束</dt><dd>{dateTime(current.ended_at)}</dd></div>}
          {current.refund && <div><dt>预约金退款</dt><dd>{money(current.refund.amount)} · {fundingStates[current.refund.status]}</dd></div>}
        </dl>
        {current.refund && ["PENDING", "FAILED"].includes(current.refund.status) && <button className="button"
          onClick={() => setSequence(value => value + 1)}>核对预约金结果</button>}
        {!ongoing && <p role="status">{current.invoice_id ? "已生成结算主单。" : "牙椅已释放，等待前台结算交接。"}</p>}
        {!!current.termination_reason && <p>中止原因 {current.termination_reason}</p>}
        {!!current.clinical_notes && <p>诊疗记录 {current.clinical_notes}</p>}
        {current.invoice_id && <button className="button" onClick={() => open("/billing/invoices/" + current.invoice_id)}>查看主单或提交更正</button>}
      </section>
      {context.fault && <p className="error-text" role="alert">{context.fault}</p>}
      {context.data && <PatientContext context={context.data} onReload={() => setSequence(value => value + 1)} />}
      {!ongoing && current.allergy_reviews && <section className="schedule-panel"><h2>本次过敏核对</h2>
        <AllergyHistory events={current.allergy_reviews} />
      </section>}
      <section className="schedule-panel">
        <div className="schedule-heading"><h2>本次治疗</h2><strong>暂计 {money(current.estimated_amount)}</strong></div>
        {current.treatment_items.length ? <div className="schedule-scroll"><table className="report-table">
          <thead><tr>{["项目", "实际数量", "标准单位", "冻结单价", "小计"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{current.treatment_items.map(row => <tr key={row.item_id}><th scope="row">{row.name}</th>
            <td>{row.units}</td><td>{row.unit}</td><td>{money(row.unit_price)}</td><td>{money(row.amount)}</td></tr>)}</tbody>
        </table></div> : <p>暂无已实施项目。</p>}
      </section>
      <section className="schedule-panel">
        <h2>耗材</h2>
        {current.materials?.length ? <ul className="compact-list">{current.materials.map(row => <li key={row.usage_id}>
          {row.name} · {row.quantity} {row.unit} · 成本单价 {money(row.unit_cost)}
        </li>)}</ul> : <p>暂无实际耗材记录。</p>}
      </section>
      {ongoing && <>
        <TreatmentForm visit={current} onChange={() => setSequence(value => value + 1)} />
        <section className="schedule-panel">
          <h2>结束诊疗</h2>
          <ActionFeedback {...action} />
          <form className="schedule-form treatment-ending" onSubmit={close}>
            <fieldset className="record-fields" disabled={action.busy || action.unknown}>
              <label>结束方式<select value={ending} onChange={event => setEnding(event.target.value as typeof ending)}>
                <option value="finish">正常结束</option><option value="terminate">中止诊疗</option>
              </select></label>
              <label>诊疗记录<textarea value={notes} onChange={event => setNotes(event.target.value)} /></label>
              {ending === "terminate" && <label>中止原因<textarea required value={reason} onChange={event => setReason(event.target.value)} /></label>}
            </fieldset>
            {ending === "finish" && !current.treatment_items.length && <p>登记至少一项实际治疗后可正常结束。</p>}
            <button className="button primary" disabled={action.busy || action.unknown || (ending === "finish" && !current.treatment_items.length)}>
              {ending === "finish" ? "确认正常结束" : "确认中止并交接结算"}
            </button>
          </form>
        </section>
      </>}
    </>}
  </div>;
}
