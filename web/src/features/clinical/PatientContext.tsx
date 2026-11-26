import { useState } from "react";
import { useRead } from "../../shared/useRead";
import { dateTime } from "../../shared/format";
import { AllergySection } from "./AllergyReview";
import { ClinicalContext, type Visit, visitStates } from "./clinicalTypes";
import "./clinical.css";

export function PatientContext({ context, onReload }: { context: ClinicalContext; onReload: () => void }) {
  const [opened, setOpened] = useState<string>();
  const enabled = opened && context.history.some(item => item.visit_id === opened && item.can_open_detail);
  const detail = useRead<Visit>(enabled ? "/visits/" + opened : undefined);
  return <section className="schedule-panel">
    <h2>病史与过敏</h2>
    {context.special_requirement && <p><strong>特殊需求</strong> {context.special_requirement}</p>}
    <AllergySection key={context.appointment.appointment_id} context={context} onReload={onReload} />
    <h3>历史就诊</h3>
    {context.history.length ? <ul className="compact-list">{context.history.map(entry => <li key={entry.visit_id}>
      就诊 {entry.visit_id} · {dateTime(entry.ended_at)} · {visitStates[entry.status] ?? entry.status}
      {!!entry.treatments?.length && <span>{entry.treatments.join("、")}</span>}
      {entry.can_open_detail && <button className="text-action" type="button" aria-pressed={opened === entry.visit_id}
        onClick={() => setOpened(opened === entry.visit_id ? undefined : entry.visit_id)}>查看本人记录</button>}
    </li>)}</ul> : <p>没有可回查的历史就诊。</p>}
    {enabled && <section className="appointment-action" aria-label="本人既往诊疗记录">
      <div className="schedule-heading"><h3>本人既往诊疗记录 · {opened}</h3>
        <button className="button" onClick={() => setOpened(undefined)}>收起记录</button></div>
      {detail.loading && <p role="status">正在核对临床记录的访问权限…</p>}
      {detail.fault && <p className="error-text" role="alert">{detail.fault}</p>}
      {detail.data && !detail.data.main_dentist_id && <p role="alert">当前账号无法查看该临床记录。</p>}
      {detail.data?.main_dentist_id && <p>{detail.data.clinical_notes || detail.data.termination_reason || "此就诊没有记录临床原文。"}</p>}
    </section>}
  </section>;
}
