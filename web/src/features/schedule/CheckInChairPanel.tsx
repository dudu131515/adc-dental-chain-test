import { useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { request } from "../../shared/api";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { Appointment, Chair } from "./appointmentTypes";

export function CheckInChairPanel({ row, onUpdate }: { row: Appointment; onUpdate: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [chair, setChair] = useState("");
  const [opened, setOpened] = useState(false);
  const [sequence, setSequence] = useState(0);
  const action = useAction();
  const base = "/appointments/" + row.appointment_id;
  const needsChair = ["CHECKED_IN", "IN_TREATMENT"].includes(row.status);
  const options = useRead<{ items: Chair[] }>(opened && needsChair ? base + "/chair-options" : undefined, sequence);
  const disabled = action.busy || action.unknown;

  if (!row.allowed_actions.includes("check_in") && !needsChair) return null;
  return <section className="appointment-action">
    <h3>签到与分椅</h3>
    {row.allowed_actions.includes("check_in") && <div className="schedule-form">
      <label className="inline-control"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        已核对到诊患者身份</label>
      <button className="button primary" disabled={!confirmed || disabled} onClick={() =>
        action.execute<Appointment>(base + "/check-in", { expected_claim_id: row.claim_id, identity_confirmed: true }, onUpdate, async () => {
          const result = await request<Appointment>(base);
          return result.claim_id === row.claim_id && ["CHECKED_IN", "IN_TREATMENT", "COMPLETED"].includes(result.status) ? result : undefined;
        })}>确认签到</button>
    </div>}
    {needsChair && <>
      <p>{row.chair ? "当前牙椅 " + row.chair.chair_no : "已签到 · 待分椅"}</p>
      <div className="schedule-toolbar">
        <button className="button" onClick={() => setOpened(!opened)} aria-expanded={opened}>{row.chair ? "更换牙椅" : "分配牙椅"}</button>
      </div>
      {opened && <>
        {options.loading && <p role="status">正在核对本店牙椅…</p>}
        {options.fault && <p className="error-text" role="alert">{options.fault}</p>}
        {options.data?.items.length === 0 && <p>暂无符合条件的牙椅，签到保持。可核对同店替代或使用诊所原因协调。</p>}
        {!!options.data?.items.length && <div className="schedule-form">
          <label>本店可用牙椅<select value={chair} onChange={event => setChair(event.target.value)}>
            <option value="">选择牙椅</option>{options.data.items.map(option => <option key={option.chair_id} value={option.chair_id}>
              {option.chair_no} · {option.chair_kind}
            </option>)}
          </select></label>
          <button className="button primary" disabled={!chair || disabled} onClick={() =>
            action.execute<unknown>(base + "/assign-chair", { expected_claim_id: row.claim_id, chair_id: chair }, () => {
              onUpdate(); setOpened(false); setChair("");
            }, async () => {
              const result = await request<Appointment>(base);
              return result.chair?.chair_id === chair && result.claim_id === row.claim_id ? result : undefined;
            })}>保存分椅</button>
        </div>}
        <button className="button" disabled={options.loading || disabled} onClick={() => setSequence(value => value + 1)}>刷新牙椅选项</button>
      </>}
    </>}
    <ActionFeedback {...action} />
  </section>;
}
