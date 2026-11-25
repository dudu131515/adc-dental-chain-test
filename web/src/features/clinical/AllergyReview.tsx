import { FormEvent, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { dateTime } from "../../shared/format";
import { useAction } from "../../shared/useAction";
import { AllergyEntry, AllergyReview, ClinicalContext, ReviewStatus } from "./clinicalTypes";

const statusNames: Record<ReviewStatus, string> = {
  UNVERIFIED: "未核实", NONE_KNOWN: "患者确认无已知过敏", KNOWN: "已知过敏",
};
type DraftStatus = AllergyReview["status"] | "";
type DraftRow = { id: number; allergen: string; notes: string };

export function AllergyHistory({ events }: { events: AllergyReview[] }) {
  if (!events.length) return <p>暂无过敏核对记录。</p>;
  return <details className="allergy-history">
    <summary>查看过敏核对记录（{events.length}）</summary>
    <ol>{events.map(event => <li key={event.review_id}>
      <strong>{statusNames[event.status]}</strong> · {dateTime(event.reviewed_at)} · {event.dentist_name}
      <span>新增 {event.changes.added} 项 · 修改 {event.changes.updated} 项 · 移除 {event.changes.removed} 项</span>
    </li>)}</ol>
  </details>;
}

function AllergyEditor({ context, onSaved, onCancel }: {
  context: ClinicalContext; onSaved: () => void; onCancel: () => void;
}) {
  // Hold the exact version and booking the dentist opened, including during background refreshes.
  const [baseline] = useState(() => ({
    version: context.allergy_review.version, claim: context.appointment.claim_id,
    appointment: context.appointment.appointment_id, count: context.allergies.length,
  }));
  const [status, setStatus] = useState<DraftStatus>(
    context.allergy_review.status === "UNVERIFIED" ? "" : context.allergy_review.status,
  );
  const [rows, setRows] = useState<DraftRow[]>(() => {
    const source: AllergyEntry[] = context.allergies.length ? context.allergies : [{ allergen: "" }];
    return source.map((row, id) => ({ id, allergen: row.allergen, notes: row.notes ?? "" }));
  });
  const [error, setError] = useState("");
  const action = useAction();
  const locked = action.busy || action.unknown;

  function patchRow(id: number, changes: Partial<AllergyEntry>) {
    setRows(list => list.map(row => row.id === id ? { ...row, ...changes, notes: changes.notes ?? row.notes } : row));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!status) return;
    const allergies = status === "KNOWN" ? rows.map(row => ({
      allergen: row.allergen.trim(), notes: row.notes.trim(),
    })) : [];
    if (status === "KNOWN" && (!allergies.length || allergies.some(row => !row.allergen))) {
      setError("请至少填写一种过敏原，并移除多余的空行。");
      return;
    }
    if (new Set(allergies.map(row => row.allergen.toLowerCase())).size !== allergies.length) {
      setError("同一过敏原请只登记一次，可将说明合并。");
      return;
    }
    action.execute<AllergyReview>("/appointments/" + baseline.appointment + "/allergy-reviews", {
      expected_claim_id: baseline.claim, expected_version: baseline.version, status, allergies,
    }, onSaved);
  }

  return <div className="allergy-editor">
    <ActionFeedback {...action} />
    {error && <p className="error-text" role="alert">{error}</p>}
    <form onSubmit={submit}>
      <fieldset disabled={locked}>
        <legend>与患者核对过敏史</legend>
        <label>核对结果
          <select required value={status} onChange={event => { setStatus(event.target.value as DraftStatus); setError(""); }}>
            <option value="" disabled>请选择核对结果</option>
            <option value="KNOWN">已知过敏</option>
            <option value="NONE_KNOWN">患者确认无已知过敏</option>
          </select>
        </label>
        {status === "KNOWN" && <>
          {rows.map((row, index) => <div className="allergy-row" key={row.id}>
            <label>过敏原 {index + 1}<input required maxLength={120} value={row.allergen}
              onChange={event => patchRow(row.id, { allergen: event.target.value })} /></label>
            <label>反应或备注 {index + 1}（选填）<textarea rows={2} value={row.notes}
              onChange={event => patchRow(row.id, { notes: event.target.value })} /></label>
            <button type="button" className="button" aria-label={"移除过敏原 " + (index + 1)}
              onClick={() => setRows(list => list.filter(item => item.id !== row.id))}>移除</button>
          </div>)}
          <button type="button" className="button" onClick={() => setRows(list => [
            ...list, { id: Math.max(-1, ...list.map(row => row.id)) + 1, allergen: "", notes: "" },
          ])}>添加过敏原</button>
        </>}
        {status === "NONE_KNOWN" && baseline.count > 0 &&
          <p role="status">保存后将从当前清单移除已登记的 {baseline.count} 项过敏原。请先与患者逐项核实。</p>}
        <div className="schedule-toolbar">
          <button type="submit" className="button primary" disabled={!status || (status === "KNOWN" && !rows.length)}>
            {action.busy ? "正在保存…" : "确认并保存核对结果"}
          </button>
          <button type="button" className="button" onClick={onCancel}>
            {action.fault ? "放弃本次编辑并重新读取" : "取消编辑"}
          </button>
        </div>
      </fieldset>
    </form>
  </div>;
}

export function AllergySection({ context, onReload }: { context: ClinicalContext; onReload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const state = context.allergy_review;
  const latest = state.history[0];
  const canEdit = ["CHECKED_IN", "IN_TREATMENT"].includes(context.appointment.status);
  return <div className="allergy-section">
    <div className="schedule-heading"><h3>过敏史</h3>
      <strong className="allergy-status" data-status={state.status}>{statusNames[state.status]}</strong>
    </div>
    {state.status === "UNVERIFIED" && <p>尚无患者核对结果。</p>}
    {state.status === "KNOWN" && <ul className="allergen-list">{context.allergies.map(row => <li key={row.allergen}>
      <strong>{row.allergen}</strong>{row.notes && <span>{row.notes}</span>}
    </li>)}</ul>}
    {latest && <p>最近核对 · {dateTime(latest.reviewed_at)} · {latest.dentist_name}</p>}
    {state.status === "KNOWN" && !latest && <p>既有登记，尚无核对时间。</p>}
    <AllergyHistory events={state.history} />
    {saved && !editing && <p role="status">已保存本次过敏核对。</p>}
    {canEdit && (editing ? <AllergyEditor context={context} onSaved={() => {
      setEditing(false); setSaved(true); onReload();
    }} onCancel={() => { setEditing(false); onReload(); }} /> :
      <button className="button" onClick={() => { setEditing(true); setSaved(false); }}>核对或更新过敏史</button>)}
  </div>;
}
