import { useState } from "react";
import { WorkArea } from "../../shared/AppShell";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { request } from "../../shared/api";
import { dateTime } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { Appointment, Chair, appointmentStates } from "../schedule/appointmentTypes";
import { ClinicalContext, Visit } from "./clinicalTypes";
import { PatientContext } from "./PatientContext";

type QueueEntry = Appointment & { chair: Chair | null; visit_id: string | null; check_in_at?: string };

export function ClinicalQueue({ clinicId, path, open }: WorkArea) {
  const preview = path.match(/^\/clinical\/appointments\/(\d+)$/)?.[1];
  const [checked, setChecked] = useState(false);
  const action = useAction();
  const [sequence, setSequence] = useState(0);
  const queue = useRead<{ items: QueueEntry[] }>(preview ? undefined : "/clinical/queue");
  const context = useRead<ClinicalContext>(preview ? "/appointments/" + preview + "/clinical-context" : undefined, sequence);

  function start(entry: ClinicalContext) {
    const base = "/appointments/" + entry.appointment.appointment_id;
    action.execute<Visit>(base + "/start-visit", { expected_claim_id: entry.appointment.claim_id }, result => {
      open("/clinical/visits/" + result.visit_id);
    }, async () => {
      const result = await request<{ items: QueueEntry[] }>("/clinical/queue");
      const recorded = result.items.find(row => row.appointment_id === entry.appointment.appointment_id)?.visit_id;
      return recorded ? request<Visit>("/visits/" + recorded) : undefined;
    });
  }

  const entries = queue.data?.items.filter(row => !clinicId || row.clinic.clinic_id === clinicId) ?? [];
  return <div className="operations-sections">
    {!preview ? <section className="schedule-panel">
      <h1>接诊队列</h1>
      {queue.loading && <p role="status">正在读取接诊队列…</p>}
      {queue.fault && <p className="error-text" role="alert">{queue.fault}</p>}
      {queue.data && !entries.length && <p>当前门店没有待接诊或正在诊疗的预约。</p>}
      <ul className="compact-list">{entries.map(entry => <li key={entry.appointment_id}>
        <button className="text-action" onClick={() => {
          setChecked(false);
          open(entry.visit_id ? "/clinical/visits/" + entry.visit_id : "/clinical/appointments/" + entry.appointment_id);
        }}>{entry.patient_display?.name ?? entry.appointment_no}</button>
        <span>{entry.clinic.name} · {dateTime(entry.start_at)}</span>
        <span className="status-tag" data-state={entry.status}>
          {entry.status === "CHECKED_IN" && !entry.chair ? "已签到 · 待分椅" : appointmentStates[entry.status]}
        </span>
        {entry.chair && <span>牙椅 {entry.chair.chair_no}</span>}
      </li>)}</ul>
    </section> : <>
      <div className="schedule-toolbar"><button className="button" onClick={() => open("/clinical")}>返回接诊队列</button></div>
      {context.loading && <p role="status">正在读取接诊资料…</p>}
      {context.fault && <p className="error-text" role="alert">{context.fault}</p>}
      {context.data && <>
        <section className="schedule-panel">
          <h1>{context.data.appointment.patient_display?.name ?? "接诊准备"}</h1>
          <p>{context.data.appointment.appointment_no} · {context.data.appointment.clinic.name} · {context.data.appointment.dentist.name}</p>
          <p>{context.data.chair ? "牙椅 " + context.data.chair.chair_no : "已签到 · 待分椅"}</p>
        </section>
        <PatientContext context={context.data} onReload={() => setSequence(value => value + 1)} />
        <section className="schedule-panel">
          <h2>实际开始接诊</h2>
          <ActionFeedback {...action} />
          {context.data.appointment.status === "CHECKED_IN" && context.data.chair ? <>
            <label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
              已核对患者、过敏与椅位</label>{" "}
            <button className="button primary" disabled={!checked || action.busy || action.unknown} onClick={() => context.data && start(context.data)}>
              开始接诊
            </button>
          </> : <p>完成前台签到和分椅后可开始接诊。</p>}
        </section>
      </>}
    </>}
  </div>;
}
