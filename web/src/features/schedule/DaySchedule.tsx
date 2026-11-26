import { appointmentStates } from "./appointmentTypes";
import { addDays, localTime, type AppointmentSummary, type Shift } from "./types";

export type CalendarBoard = { shifts: Shift[]; appointments: AppointmentSummary[] };
export type BookingPreference = { dentistId: string; time: string };
type Interval = { start: number; end: number };
const occupied = new Set(["CONFIRMED", "CHECKED_IN", "IN_TREATMENT"]);
const minute = 60_000;

function span(row: { start_at: string; end_at: string }, window: Interval): Interval {
  return { start: Math.max(window.start, Date.parse(row.start_at)), end: Math.min(window.end, Date.parse(row.end_at)) };
}

function remaining(window: Interval, busy: Interval[]) {
  const gaps: Interval[] = [];
  let available = window.start;
  for (const time of [...busy].sort((left, right) => left.start - right.start)) {
    if (time.end <= available || time.start >= window.end) continue;
    if (time.start > available) gaps.push({ start: available, end: time.start });
    available = Math.max(available, time.end);
  }
  if (available < window.end) gaps.push({ start: available, end: window.end });
  return gaps;
}

function label(time: number, dayEnd: number) {
  return time === dayEnd ? "24:00" : localTime(new Date(time).toISOString());
}

export function DaySchedule({ board, names, date, status, onAppointment, onCandidate }: {
  board: CalendarBoard; names: ReadonlyMap<string, string>; date: string; status: string;
  onAppointment: (id: string) => void; onCandidate?: (selection: BookingPreference) => void;
}) {
  const bounds = { start: Date.parse(date + "T00:00:00+08:00"), end: Date.parse(addDays(date, 1) + "T00:00:00+08:00") };
  const published = board.shifts.filter(row => row.status === "PUBLISHED");
  const dentists = [...new Set([...published, ...board.appointments].map(row => row.dentist_id))];
  const today = Math.ceil(Date.now() / minute) * minute;
  const range = (time: Interval) => label(time.start, bounds.end) + "–" + label(time.end, bounds.end);
  if (!dentists.length) return <p>所选门店与日期暂无已发布班次或预约。</p>;
  return <div className="appointment-day">
    <div className="appointment-day-key">
      <strong>已发布班次</strong><span>已有预约</span><span>候选空档</span><span>不可用</span>
    </div>
    <p className="muted">候选空档按班次和预约显示。选择主诊项目后，系统再核对预约资格、牙椅和可用时段。</p>
    {dentists.map(id => {
      const name = names.get(id) ?? "牙医 " + id;
      const shifts = published.filter(row => row.dentist_id === id).map(row => span(row, bounds));
      const appointments = board.appointments.filter(row => row.dentist_id === id);
      const active = appointments.filter(row => occupied.has(row.status)).map(row => span(row, bounds));
      const unavailable = remaining(bounds, shifts);
      const slots = shifts.flatMap(shift => remaining({ start: Math.max(shift.start, today), end: shift.end }, active));
      const tiles = [
        ...appointments.filter(row => !status || row.status === status).map(row => ({
          key: "appointment-" + row.appointment_id, start: Date.parse(row.start_at),
          tile: <button className="shift-slot appointment-tile" onClick={() => onAppointment(row.appointment_id)}>
            <strong>{row.patient_display ?? row.appointment_no}</strong>
            <span>{range(span(row, bounds))} · {appointmentStates[row.status] ?? row.status}</span>
          </button>,
        })),
        ...slots.map(slot => ({
          key: "candidate-" + slot.start, start: slot.start,
          tile: onCandidate
            ? <button className="shift-slot appointment-candidate" onClick={() => onCandidate({ dentistId: id, time: label(slot.start, bounds.end) })}>
              {range(slot)} 候选空档
            </button>
            : <span className="shift-slot appointment-candidate">{range(slot)} 候选空档</span>,
        })),
      ].sort((left, right) => left.start - right.start);
      return <section key={id} aria-label={name} className="appointment-lane">
        <div className="appointment-lane-dentist">
          <h3>{name}</h3>
          {shifts.length ? shifts.map(shift => <span key={shift.start}>{range(shift)}</span>) : <span>无已发布班次</span>}
        </div>
        <div className="appointment-lane-detail">
          {tiles.length ? <ul className="appointment-lane-times">{tiles.map(item => <li key={item.key}>{item.tile}</li>)}</ul>
            : <p className="muted">当前筛选无可展示的预约或候选空档。</p>}
          {!!unavailable.length && <p className="appointment-unavailable">未排班 · {unavailable.map(range).join("、")}</p>}
          {shifts.some(shift => shift.start < today) && <p className="appointment-unavailable">已过的班次时段仅供回查。</p>}
        </div>
      </section>;
    })}
  </div>;
}
