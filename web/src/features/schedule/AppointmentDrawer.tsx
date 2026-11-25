import { ReactNode, useEffect, useRef, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { request } from "../../shared/api";
import { canWorkAt, StaffIdentity } from "../../shared/AppShell";
import { dateTime, money } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { AppointmentActions } from "./AppointmentActions";
import { Appointment, appointmentStates, fundingStates, FundsStatus } from "./appointmentTypes";
import { CheckInChairPanel } from "./CheckInChairPanel";
import { HandoverEvidence } from "./HandoverEvidence";

export function ScheduleDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const focus = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    focus.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <aside className="schedule-drawer" aria-label={title} onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <div className="schedule-heading"><h2>{title}</h2><button className="button" ref={focus} onClick={onClose}>关闭详情</button></div>
    {children}
  </aside>;
}

export function AppointmentDrawer({ id, identity, open, onClose, onChange }: {
  id: string; identity: StaffIdentity; open: (to: string) => void; onClose: () => void; onChange: () => void;
}) {
  const [sequence, setSequence] = useState(0);
  const read = useRead<Appointment>("/appointments/" + id, sequence);
  const row = read.data;
  const isFront = row && canWorkAt(identity, "FRONT_DESK", row.clinic.clinic_id);
  const isDentist = row && canWorkAt(identity, "DENTIST", row.clinic.clinic_id) && row.dentist.dentist_id === identity.employee_id;
  const canHandover = ["FRONT_DESK", "CLINIC_MANAGER", "HQ_SCHEDULER"].some(role => identity.capabilities.includes(role));
  const action = useAction();
  const refresh = () => { onChange(); setSequence(value => value + 1); };
  return <ScheduleDrawer title="预约详情" onClose={onClose}>
    {read.loading && <p role="status">正在核对预约…</p>}
    {read.fault && <p className="error-text" role="alert">{read.fault}</p>}
    {row && <>
      <p><strong>{row.appointment_no}</strong>{" "}
        <span className="status-tag" data-state={row.status}>
          {row.status === "CHECKED_IN" && "chair" in row && !row.chair ? "已签到 · 待分椅" : appointmentStates[row.status]}
        </span>
      </p>
      <dl className="inline-facts">
        {row.patient_display && <div><dt>患者</dt><dd>{row.patient_display.name}</dd></div>}
        <div><dt>门店</dt><dd>{row.clinic.name}</dd></div><div><dt>牙医</dt><dd>{row.dentist.name}</dd></div>
        <div><dt>主诊项目</dt><dd>{row.treatment.name}</dd></div>
        <div><dt>时段开始</dt><dd>{dateTime(row.start_at)}</dd></div><div><dt>时段结束</dt><dd>{dateTime(row.end_at)}</dd></div>
      </dl>
      {row.deposit && <section className="appointment-action">
        <h3>预约金</h3>
        <p>{money(row.deposit.amount)} · {fundingStates[row.deposit.status]}</p>
        {row.refund && <p>退金 {money(row.refund.amount)} · {fundingStates[row.refund.status]}</p>}
        {row.refund?.status === "PENDING" && <button className="button" onClick={refresh}>核对退金结果</button>}
        {isFront && row.refund?.status === "FAILED" && <button className="button" disabled={action.busy || action.unknown}
          onClick={() => {
            const path = "/deposit-refunds/" + row.refund?.refund_id;
            action.execute<FundsStatus>(path + "/retry", {}, refresh, async () => {
              const latest = await request<FundsStatus>(path);
              return latest.status !== "FAILED" ? latest : undefined;
            });
          }}>沿原义务重试退金</button>}
        <ActionFeedback {...action} />
      </section>}
      {isFront && <CheckInChairPanel key={row.claim_id} row={row} onUpdate={refresh} />}
      <AppointmentActions key={row.claim_id} row={row} identity={identity} onUpdate={refresh} />
      {row.visit_id && isDentist && <button className="button" onClick={() => open("/clinical/visits/" + row.visit_id)}>查看诊疗记录</button>}
      {row.visit_id && row.status === "COMPLETED" && isFront &&
        <button className="button" onClick={() => open("/billing/visits/" + row.visit_id)}>查看待结算就诊</button>}
    </>}
    {canHandover && <HandoverEvidence id={id} />}
  </ScheduleDrawer>;
}
