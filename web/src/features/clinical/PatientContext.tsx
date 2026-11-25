import { dateTime } from "../../shared/format";
import { AllergySection } from "./AllergyReview";
import { ClinicalContext, visitStates } from "./clinicalTypes";
import "./clinical.css";

export function PatientContext({ context, onReload }: { context: ClinicalContext; onReload: () => void }) {
  return <section className="schedule-panel">
    <h2>病史与过敏</h2>
    {context.special_requirement && <p><strong>特殊需求</strong> {context.special_requirement}</p>}
    <AllergySection key={context.appointment.appointment_id} context={context} onReload={onReload} />
    <h3>历史就诊</h3>
    {context.history.length ? <ul className="compact-list">{context.history.map(entry => <li key={entry.visit_id}>
      就诊 {entry.visit_id} · {dateTime(entry.ended_at)} · {visitStates[entry.status] ?? entry.status}
      {entry.clinical_notes && <span>{entry.clinical_notes}</span>}
    </li>)}</ul> : <p>没有可回查的历史就诊。</p>}
  </section>;
}
