import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import { dateTime, money } from "../../shared/format";
import { useEffect, useState } from "react";
import { fundingStates } from "./appointmentTypes";

type Evidence = {
  appointment_no: string; origin_clinic_id: string; old_start_at: string; old_end_at: string; changed_at: string;
  reason?: string; deposit?: { amount: string; status: string }; refund?: { amount: string; status: string };
};

export function HandoverEvidence({ id }: { id: string }) {
  const request = useApiRequest();
  const [items, setItems] = useState<Evidence[]>([]);
  const [fault, setFault] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request<{ items: Evidence[] }>("/appointments/" + id + "/handover-evidence", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setItems(data.items); })
      .catch(error => {
        if (!controller.signal.aborted && !(error instanceof ApiError && error.status === 404)) {
          setFault("暂时无法核对本店交接记录。");
        }
      });
    return () => controller.abort();
  }, [id]);
  if (!items.length && !fault) return null;
  return <section className="appointment-action">
    <h3>本店原安排与交接证据</h3>
    {fault && <p className="error-text" role="alert">{fault}</p>}
    <ul className="evidence-list">{items.map(row => <li key={row.origin_clinic_id + ":" + row.changed_at}>
      <p>{row.appointment_no} · 原时段 {dateTime(row.old_start_at)} 至 {dateTime(row.old_end_at)}</p>
      <p>交接于 {dateTime(row.changed_at)}{row.reason && " · " + row.reason}</p>
      {row.deposit && <p>原预约金 {money(row.deposit.amount)} · {fundingStates[row.deposit.status]}</p>}
      {row.refund && <p>交接时原退金 {money(row.refund.amount)} · {fundingStates[row.refund.status]}</p>}
    </li>)}</ul>
  </section>;
}
