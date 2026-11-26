import { useEffect, useRef, useState } from "react";

import type { StaffIdentity } from "../../shared/AppShell";
import { useApiRequest } from "../../shared/ApiTransport";
import { ApiError } from "../../shared/api";
import { canWorkAt } from "../../shared/navigation";
import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { ShiftBatchPanel } from "./ShiftBatchPanel";
import { ShiftDetails, ShiftEditor } from "./ShiftDetails";
import {
  BatchAction, BatchResult, BoardDentist, BoardShift, ClinicOption, DraftContext, RunBatch, Shortage, WeeklySchedule,
  conflictLabels, dentistsAt,
} from "./shiftBoardTypes";
import { addDays, localDate, localTime, shiftLabels } from "./types";
import "./shift-board.css";

type Context = {
  identity: StaffIdentity;
  clinicId: string;
  onAppointment?: (id: string, start: string) => void;
  initialWeek?: string;
};

type BatchMode = Exclude<BatchAction["action"], "copy">;

const boardRoles = ["HQ_SCHEDULER", "CLINIC_MANAGER", "DENTIST"];
const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", weekday: "short" });

function monday(date: string) {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

function weekStart(queryString: string, today: string) {
  const query = new URLSearchParams(queryString).get("week");
  if (query && /^\d{4}-\d{2}-\d{2}$/.test(query) && !Number.isNaN(Date.parse(query))) return query;
  return monday(today);
}

function overlapsDay(item: { start_at: string; end_at: string }, day: string) {
  const start = Date.parse(day + "T00:00:00+08:00");
  const end = Date.parse(addDays(day, 1) + "T00:00:00+08:00");
  return Date.parse(item.start_at) < end && Date.parse(item.end_at) > start;
}

export function ShiftBoard({ identity, clinicId, onAppointment, initialWeek }: Context) {
  const { router, workday } = useWorkspaceRuntime();
  const request = useApiRequest();
  const [week, setWeek] = useState(() => initialWeek ?? weekStart(router.read().search, workday));
  const [clinic, setClinic] = useState(clinicId);
  const [dentist, setDentist] = useState("");
  const [listView, setListView] = useState(false);
  const [board, setBoard] = useState<WeeklySchedule>({ shifts: [] });
  const [dentists, setDentists] = useState<BoardDentist[]>([]);
  const [activeClinics, setActiveClinics] = useState<ClinicOption[]>([]);
  const [selected, setSelected] = useState<BoardShift>();
  const [draft, setDraft] = useState<DraftContext>();
  const [mode, setMode] = useState<BatchMode>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [feedback, setFeedback] = useState({ message: "", error: "" });
  const [readError, setReadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [batchPending, setBatchPending] = useState(false);
  const pendingBatch = useRef(false);
  const retry = useRef<{ signature: string; actionKey: string } | undefined>(undefined);
  const origin = useRef<HTMLButtonElement | null>(null);
  const closeNew = useRef<HTMLButtonElement>(null);

  const clinics = identity.clinics.filter(row => boardRoles.some(role => canWorkAt(identity, role, row.clinic_id)));
  const writableClinics = activeClinics.filter(row => canWorkAt(identity, "HQ_SCHEDULER", row.clinic_id));
  const scheduler = writableClinics.some(row => !clinic || row.clinic_id === clinic);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const shifts = board.shifts;
  const shortages = board.shortages ?? [];
  const conflicts = board.conflicts ?? [];

  useEffect(() => {
    setClinic(clinicId);
    setDentist("");
    setSelected(undefined);
    setDraft(undefined);
    setMode(undefined);
    setChosen([]);
  }, [clinicId]);

  useEffect(() => {
    const controller = new AbortController();
    request<{ items: ClinicOption[] }>("/clinics", { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && Array.isArray(result.items)) setActiveClinics(result.items);
    }).catch(failure => {
      if (!controller.signal.aborted) setReadError(failure.message || "无法读取可排班门店。");
    });
    return () => controller.abort();
  }, [request]);

  useEffect(() => {
    const params = new URLSearchParams({ date_from: week, date_to: addDays(week, 6), view: "week" });
    if (clinic) params.set("clinic_id", clinic);
    if (dentist) params.set("dentist_id", dentist);
    const controller = new AbortController();
    setLoading(true);
    setReadError("");
    Promise.all([
      request<WeeklySchedule>("/schedule/board?" + params.toString(), { signal: controller.signal }),
      request<{ items: BoardDentist[] }>("/schedule/dentists", { signal: controller.signal }),
    ]).then(([schedule, people]) => {
      if (controller.signal.aborted) return;
      setBoard(schedule);
      setDentists(people.items);
      setSelected(current => current ? schedule.shifts.find(row => row.shift_id === current.shift_id) ?? current : undefined);
    }).catch(failure => {
      if (!controller.signal.aborted) {
        setBoard({ shifts: [] });
        setReadError(failure.message || "无法读取周排班。");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [week, clinic, dentist, refresh, request]);

  useEffect(() => {
    if (draft) closeNew.current?.focus();
  }, [draft]);

  function clearSelection() {
    setSelected(undefined);
    setDraft(undefined);
    setMode(undefined);
    setChosen([]);
    setFeedback({ message: "", error: "" });
  }

  function go(date: string) {
    clearSelection();
    const query = new URLSearchParams(router.read().search);
    query.set("week", date);
    if (!initialWeek) router.write(router.read().path + "?" + query.toString());
    setWeek(date);
  }

  function open(shift: BoardShift, button: HTMLButtonElement) {
    origin.current = button;
    setDraft(undefined);
    setSelected(shift);
  }

  function create(next: DraftContext, button: HTMLButtonElement) {
    origin.current = button;
    setSelected(undefined);
    setDraft(next);
  }

  function close() {
    setSelected(undefined);
    setDraft(undefined);
    origin.current?.focus();
  }

  function updated(shift: BoardShift) {
    const date = localDate(shift.start_at);
    if (!days.includes(date)) go(monday(date));
    if (clinic && shift.clinic_id !== clinic) setClinic(shift.clinic_id);
    if (dentist && shift.dentist_id !== dentist) setDentist(shift.dentist_id);
    setDraft(undefined);
    setSelected(shift);
    setRefresh(value => value + 1);
  }

  const shownDentists = clinic ? dentistsAt(dentists, clinic) : dentists;
  const activeDentists = [...new Set(shownDentists.map(row => row.dentist_id).concat(shifts.map(row => row.dentist_id)))]
    .filter(id => !dentist || id === dentist);
  const name = (id: string) => dentists.find(row => row.dentist_id === id)?.name
    ?? shifts.find(row => row.dentist_id === id)?.dentist_name
    ?? (identity.employee_id === id ? identity.full_name || "本人" : "牙医 " + id);
  const clinicName = (id: string) => clinics.find(row => row.clinic_id === id)?.name
    ?? activeClinics.find(row => row.clinic_id === id)?.name
    ?? shifts.find(row => row.clinic_id === id)?.clinic_name ?? "门店 " + id;
  const writableAt = (id: string) => writableClinics.some(row => row.clinic_id === id);
  const eligible = (mode === "submit" || mode === "publish") ? shifts.filter(shift =>
    shift.status === (mode === "submit" ? "DRAFT" : "ACCEPTED") && writableAt(shift.clinic_id)) : [];
  const selectedBatch = eligible.filter(shift => chosen.includes(shift.shift_id));
  const exceptions = shifts.filter(row => ["PENDING", "REJECTED", "CANCELLED"].includes(row.status));

  const run: RunBatch = async (action, onSuccess) => {
    if (pendingBatch.current) return;
    setFeedback({ message: "", error: "" });
    if ("shifts" in action && action.shifts.length > 200) {
      setFeedback({ message: "", error: "每次最多办理 200 个班次，请缩小选择范围。" });
      return;
    }
    const signature = JSON.stringify(action);
    const actionKey = retry.current?.signature === signature ? retry.current.actionKey : crypto.randomUUID();
    retry.current = { signature, actionKey };
    pendingBatch.current = true;
    setBatchPending(true);
    try {
      const result = await request<BatchResult>("/shifts/batch", { method: "POST", actionKey, body: action });
      retry.current = undefined;
      if (action.action === "copy" && result.items.length && !days.includes(action.target_date)) go(monday(action.target_date));
      const operation = action.action === "submit" ? "已提交确认" : action.action === "publish" ? "已发布" : "已保存草案";
      setFeedback({ message: `${operation} ${result.items.length} 个班次${result.skipped_count ? `，跳过 ${result.skipped_count} 个相同班次` : ""}。`, error: "" });
      setChosen([]);
      setRefresh(value => value + 1);
      onSuccess?.(result);
    } catch (failure) {
      if (!(failure instanceof ApiError) || failure.error.code !== "RESULT_UNKNOWN") retry.current = undefined;
      const details = failure instanceof ApiError ? failure.error.details : undefined;
      const row = shifts.find(shift => shift.shift_id === details?.shift_id);
      const affected = row ? `${name(row.dentist_id)} · ${clinicName(row.clinic_id)} · ${localDate(row.start_at)} ${localTime(row.start_at)}。 `
        : details?.row ? `第 ${String(details.row)} 项。 ` : "";
      setFeedback({ message: "", error: affected + (failure instanceof Error ? failure.message : "无法办理批量排班。") });
    } finally {
      pendingBatch.current = false;
      setBatchPending(false);
    }
  };

  function setBatchMode(next: BatchMode) {
    setMode(current => current === next ? undefined : next);
    setChosen([]);
    setFeedback({ message: "", error: "" });
  }

  function slot(shift: BoardShift, day?: string) {
    const canSelect = eligible.some(row => row.shift_id === shift.shift_id);
    const warning = conflicts.some(item => item.shift_ids.includes(shift.shift_id));
    const first = localDate(shift.start_at);
    const last = localDate(shift.end_at);
    const time = day && day !== first
      ? (day === last ? "续班 · 至 " + localTime(shift.end_at) : "全天续班")
      : localTime(shift.start_at) + "–" + localTime(shift.end_at)
        + (last === first ? "" : last === addDays(first, 1) ? " 次日" : " " + last.slice(5));
    return <div className="shift-board-slot" key={shift.shift_id}>
      {canSelect && <input type="checkbox" checked={chosen.includes(shift.shift_id)} disabled={batchPending}
        aria-label={`选择 ${name(shift.dentist_id)} ${localDate(shift.start_at)} ${localTime(shift.start_at)} ${clinicName(shift.clinic_id)} 班次`}
        onChange={() => setChosen(ids => ids.includes(shift.shift_id) ? ids.filter(id => id !== shift.shift_id) : [...ids, shift.shift_id])} />}
      <button type="button" className="shift-slot" data-warning={warning || undefined} onClick={event => open(shift, event.currentTarget)}>
        <span>{time}</span>
        <strong>{clinicName(shift.clinic_id)}</strong>
        <small className="status-tag" data-state={shift.status}>{shiftLabels[shift.status] || shift.status}</small>
        {warning && <small className="shift-warning">冲突</small>}
      </button>
    </div>;
  }

  function addFor(id: string, day: string, hasShift: boolean) {
    const doctor = dentists.find(row => row.dentist_id === id);
    const branch = doctor && writableClinics.find(row =>
      (!clinic || row.clinic_id === clinic) && dentistsAt([doctor], row.clinic_id).length);
    return branch ? <button className="shift-add-cell" data-empty={!hasShift || undefined} type="button"
      aria-label={`为${name(id)}添加 ${day} 班次`} disabled={batchPending}
      onClick={event => create({ day, clinicId: branch.clinic_id, dentistId: id }, event.currentTarget)}>＋</button> : null;
  }

  function fillDemand(item: Shortage, button: HTMLButtonElement) {
    create({ day: localDate(item.start_at), clinicId: item.clinic_id, demand: item }, button);
  }

  const canCreate = scheduler && shownDentists.length > 0 && !loading && !readError;
  return <section className="schedule-panel shift-board">
    <div className="schedule-heading">
      <h2>跨店排班</h2>
      <div className="schedule-toolbar">
        <button className="button" onClick={() => go(addDays(week, -7))} disabled={batchPending}>上一周</button>
        <label>周起始日期 <input aria-label="周起始日期" type="date" value={week} max="9999-12-24" disabled={batchPending}
          onChange={event => event.target.value && go(event.target.value)} /></label>
        <button className="button" onClick={() => go(addDays(week, 7))} disabled={batchPending}>下一周</button>
        <button className="button" onClick={() => go(monday(workday))} disabled={batchPending}>本周</button>
      </div>
    </div>
    <div className="schedule-toolbar shift-filter-bar">
      <label>筛选门店<select value={clinic} disabled={batchPending} onChange={event => {
        clearSelection();
        setDentist("");
        setClinic(event.target.value);
      }}>
        <option value="">全部授权门店</option>
        {clinics.map(item => <option key={item.clinic_id} value={item.clinic_id}>{item.name}</option>)}
      </select></label>
      <label>筛选牙医<select value={dentist} disabled={batchPending} onChange={event => {
        clearSelection();
        setDentist(event.target.value);
      }}>
        <option value="">全部牙医</option>
        {[...new Set(shownDentists.map(row => row.dentist_id).concat(shifts.map(row => row.dentist_id)))]
          .map(id => <option key={id} value={id}>{name(id)}</option>)}
      </select></label>
      <button className="button" onClick={() => setListView(value => !value)}>{listView ? "周视图" : "列表"}</button>
    </div>
    {scheduler && <div className="schedule-toolbar shift-action-bar" aria-label="排班操作">
      <button className="button primary" disabled={!canCreate || batchPending}
        onClick={event => create({ day: week, clinicId: clinic, dentistId: dentist }, event.currentTarget)}>拟排班次</button>
      <button className="button" disabled={!canCreate || batchPending} aria-expanded={mode === "draft"} onClick={() => setBatchMode("draft")}>批量拟排</button>
      <button className="button" disabled={loading || batchPending || !!readError} aria-expanded={mode === "reuse_week"} onClick={() => setBatchMode("reuse_week")}>复用上一周</button>
      <button className="button" disabled={loading || batchPending || !!readError} aria-expanded={mode === "submit"} onClick={() => setBatchMode("submit")}>批量提交</button>
      <button className="button" disabled={loading || batchPending || !!readError} aria-expanded={mode === "publish"} onClick={() => setBatchMode("publish")}>批量发布</button>
    </div>}
    {mode && <ShiftBatchPanel mode={mode} week={week} days={days} clinic={clinic} dentist={dentist}
      clinics={clinic ? writableClinics.filter(row => row.clinic_id === clinic) : writableClinics}
      dentists={shownDentists} selected={selectedBatch} eligible={eligible} pending={batchPending}
      name={name} clinicName={clinicName} onSelectAll={() => setChosen(selectedBatch.length === eligible.length
        ? [] : eligible.map(row => row.shift_id))} onClose={() => { setMode(undefined); setChosen([]); }} run={run} />}
    {feedback.message && <p className="shift-feedback" role="status">{feedback.message}</p>}
    {feedback.error && <p className="error-text" role="alert">{feedback.error}</p>}
    {readError && <p role="alert" className="error-text">{readError}</p>}
    {loading ? <p className="muted" role="status">正在读取周排班…</p> : listView ? (
      <ul className="compact-list">{shifts.map(shift => <li key={shift.shift_id}>
        <strong>{name(shift.dentist_id)}</strong><span>{localDate(shift.start_at)}</span>{slot(shift)}
      </li>)}</ul>
    ) : <div className="schedule-scroll">
      <table className="shift-grid">
        <thead><tr><th scope="col">牙医</th>{days.map(day => {
          const missing = shortages.filter(row => overlapsDay(row, day)).length;
          return <th scope="col" key={day}>
            <span>{day.slice(5)} · {weekday.format(new Date(day + "T00:00:00Z"))}</span>
            {missing > 0 && <small className="shift-warning">{missing} 项缺口</small>}
          </th>;
        })}</tr></thead>
        <tbody>
          {activeDentists.map(id => <tr key={id}>
            <th scope="row">{name(id)}</th>
            {days.map(day => {
              const rows = shifts.filter(shift => shift.dentist_id === id && overlapsDay(shift, day));
              return <td key={day}>{rows.map(row => slot(row, day))}{scheduler && addFor(id, day, rows.length > 0)}</td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>}
    {!loading && !readError && !shifts.length && <p className="muted">本周没有可见班次。</p>}
    {!loading && !readError && <section className="shift-anomalies" aria-labelledby="shift-anomalies-title">
      <h3 id="shift-anomalies-title">待处理排班</h3>
      {shortages.length > 0 && <div>
        <h4>排班缺口</h4>
        <ul className="compact-list">{shortages.map(item => <li key={item.demand_id}>
          <strong>{clinicName(item.clinic_id)} · 缺 {item.missing_count} 位牙医</strong>
          <span>{localDate(item.start_at)} {localTime(item.start_at)}–{localTime(item.end_at)} · 需求 {item.required_count} 人</span>
          {writableAt(item.clinic_id) && <button className="button" type="button" onClick={event => fillDemand(item, event.currentTarget)}>补排</button>}
        </li>)}</ul>
      </div>}
      {conflicts.length > 0 && <div>
        <h4>班次冲突</h4>
        <ul className="compact-list">{conflicts.map(item => <li key={item.shift_ids.join("-")}>
          <strong>{conflictLabels[item.code]} · {name(item.dentist_id)}</strong>
          <span>{[...new Set(item.clinic_ids)].map(clinicName).join("、")}</span>
          <div className="schedule-toolbar">{shifts.filter(row => item.shift_ids.includes(row.shift_id)).map(row =>
            <button className="button" key={row.shift_id} type="button" onClick={event => open(row, event.currentTarget)}>
              {localDate(row.start_at)} {localTime(row.start_at)} · {clinicName(row.clinic_id)}
            </button>
          )}
          {clinic && item.shift_ids.some(id => !shifts.some(row => row.shift_id === id)) && <button
            className="button" type="button" onClick={() => {
              clearSelection();
              setClinic("");
              setDentist(item.dentist_id);
            }}>查看该牙医的跨店班次</button>}
          </div>
        </li>)}</ul>
      </div>}
      {exceptions.length > 0 && <div>
        <h4>待确认、拒绝及撤销</h4>
        <ul className="compact-list">{exceptions.map(row => <li key={row.shift_id}>
          <strong>{name(row.dentist_id)} · {clinicName(row.clinic_id)}</strong>
          <span>{localDate(row.start_at)} {localTime(row.start_at)} · {shiftLabels[row.status]}{row.rejection_reason ? " · " + row.rejection_reason : ""}</span>
          <button type="button" className="button" onClick={event => open(row, event.currentTarget)}>查看班次</button>
        </li>)}</ul>
      </div>}
      {!shortages.length && !conflicts.length && !exceptions.length && <p className="muted">当前范围没有待处理的班次。</p>}
    </section>}
    {draft && <aside className="schedule-drawer" aria-labelledby="shift-new-title" onKeyDown={event => {
      if (event.key === "Escape") close();
    }}>
      <div className="schedule-heading"><h2 id="shift-new-title">新增班次</h2>
        <button className="button" ref={closeNew} onClick={close}>关闭</button>
      </div>
      <ShiftEditor key={[draft.clinicId, draft.dentistId, draft.day, draft.demand?.demand_id].join(":")}
        clinics={writableClinics} dentists={dentists} draft={draft} onSave={updated} />
    </aside>}
    {selected && <ShiftDetails key={selected.shift_id} shift={selected} dentists={dentists} clinics={writableClinics}
      identity={identity} onClose={close} onSave={updated} onAppointment={onAppointment}
      canCopy={writableAt(selected.clinic_id)} batchPending={batchPending} runBatch={run} />}
  </section>;
}
