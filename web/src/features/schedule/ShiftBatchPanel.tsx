import { FormEvent, useState } from "react";

import { addDays, localDate, localTime } from "./types";
import {
  BoardDentist, BoardShift, ClinicOption, RunBatch, dentistsAt,
} from "./shiftBoardTypes";

type BatchPanelProps = {
  mode: "draft" | "reuse_week" | "submit" | "publish";
  week: string;
  days: string[];
  clinic: string;
  dentist: string;
  clinics: ClinicOption[];
  dentists: BoardDentist[];
  eligible: BoardShift[];
  selected: BoardShift[];
  pending: boolean;
  name: (id: string) => string;
  clinicName: (id: string) => string;
  onSelectAll: () => void;
  onClose: () => void;
  run: RunBatch;
};

const titles = {
  draft: "批量拟排",
  reuse_week: "复用上一周",
  submit: "批量提交",
  publish: "批量发布",
};

function BatchDraftForm({ clinic, dentist, clinics, dentists, days, pending, run, onClose }: BatchPanelProps) {
  const [branch, setBranch] = useState(clinic || clinics[0]?.clinic_id || "");
  const [error, setError] = useState("");
  const available = dentistsAt(dentists, branch);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const doctorIds = data.getAll("dentists").map(String);
    const dates = data.getAll("days").map(String);
    const start = String(data.get("start") || "");
    const end = String(data.get("end") || "");
    if (!doctorIds.length || !dates.length) {
      setError("请至少选择一位牙医和一天。");
      return;
    }
    if (end <= start) {
      setError("结束时间须晚于开始时间。");
      return;
    }
    if (doctorIds.length * dates.length > 200) {
      setError("每次最多保存 200 个班次，请减少选择范围。");
      return;
    }
    const shifts = doctorIds.flatMap(dentist_id => dates.map(day => ({
      clinic_id: branch, dentist_id, start_at: day + "T" + start + ":00+08:00", end_at: day + "T" + end + ":00+08:00",
    })));
    void run({ action: "draft", shifts }, onClose);
  }

  return <form className="shift-batch-form" aria-label="批量拟排" onSubmit={save}>
    <label>拟排门店<select value={branch} onChange={event => setBranch(event.target.value)} required>
      {clinics.map(item => <option value={item.clinic_id} key={item.clinic_id}>{item.name}</option>)}
    </select></label>
    <fieldset className="shift-checkgroup" key={branch}>
      <legend>牙医</legend>
      {available.map(person => <label key={person.dentist_id}>
        <input type="checkbox" name="dentists" value={person.dentist_id} defaultChecked={person.dentist_id === dentist} />
        {person.name}
      </label>)}
      {!available.length && <span className="muted">此门店暂无可排牙医。</span>}
    </fieldset>
    <fieldset className="shift-checkgroup">
      <legend>工作日</legend>
      {days.map(day => <label key={day}><input type="checkbox" name="days" value={day} />{day.slice(5)}</label>)}
    </fieldset>
    <div className="shift-batch-times">
      <label>开始时间<input type="time" name="start" defaultValue="09:00" required /></label>
      <label>结束时间<input type="time" name="end" defaultValue="12:00" required /></label>
    </div>
    <button className="button primary" disabled={pending || !available.length}>保存批量草案</button>
    {error && <p className="error-text" role="alert">{error}</p>}
  </form>;
}

export function ShiftBatchPanel(props: BatchPanelProps) {
  const { mode, week, clinic, dentist, eligible, selected, pending, name, clinicName, onSelectAll, onClose, run } = props;
  function transition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode !== "submit" && mode !== "publish") return;
    const data = new FormData(event.currentTarget);
    const shifts = selected.map(row => {
      const evidence = String(data.get("evidence-" + row.shift_id) || "").trim();
      return {
        shift_id: row.shift_id,
        ...(evidence ? { route_feasible: true as const, evidence_ref: evidence } : {}),
      };
    });
    void run({ action: mode, shifts }, onClose);
  }

  return <section className="shift-operation-panel" aria-label={titles[mode]}>
    <div className="schedule-heading">
      <h3>{titles[mode]}</h3>
      <button className="button" type="button" onClick={onClose} disabled={pending}>关闭批量操作</button>
    </div>
    {mode === "draft" && <BatchDraftForm {...props} />}
    {mode === "reuse_week" && <div className="shift-batch-form">
      <p>将 {addDays(week, -7)} 至 {addDays(week, -1)} 仍可安排的班次复制到本周，保存为草案。</p>
      <p className="muted">{clinic ? clinicName(clinic) : "全部可排门店"} · {dentist ? name(dentist) : "全部牙医"}</p>
      <button className="button primary" type="button" disabled={pending} onClick={() => void run({
        action: "reuse_week", target_week: week, clinic_id: clinic || undefined, dentist_id: dentist || undefined,
      }, onClose)}>复制上一周为草案</button>
    </div>}
    {(mode === "submit" || mode === "publish") && <form className="shift-batch-form" onSubmit={transition}>
      <div className="schedule-toolbar">
        <p>{eligible.length ? `已选 ${selected.length} / ${eligible.length} 个班次` : "当前范围没有可办理班次。"}</p>
        {eligible.length > 0 && <button type="button" className="button" disabled={pending} onClick={onSelectAll}>
          {selected.length === eligible.length ? "清除选择" : "选择全部可办理班次"}
        </button>}
      </div>
      {mode === "publish" && selected.length > 0 && <div className="shift-route-fields">
        <p className="muted">已核对路线可行的跨店班次，请逐条填写核验依据。</p>
        {selected.map(row => <label key={row.shift_id}>
          {name(row.dentist_id)} · {clinicName(row.clinic_id)} · {localDate(row.start_at)} {localTime(row.start_at)} 路线核验依据
          <input name={"evidence-" + row.shift_id} />
        </label>)}
      </div>}
      <button className="button primary" disabled={!selected.length || pending}>
        {mode === "submit" ? "提交所选草案" : "发布所选班次"}
      </button>
    </form>}
  </section>;
}
