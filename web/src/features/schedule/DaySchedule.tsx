import { appointmentStates } from "./appointmentTypes";
import { addDays, localTime, type AppointmentSummary, type Shift } from "./types";

type TimeSpan = { start_at: string; end_at: string };
export type CalendarBoard = { shifts: Shift[]; appointments: AppointmentSummary[]; unavailable?: TimeSpan[] };
export type BookingPreference = { dentistId: string; time: string };
type Interval = { start: number; end: number };
const occupied = new Set(["CONFIRMED", "CHECKED_IN", "IN_TREATMENT"]);
const minute = 60_000;
const halfHour = 30 * minute;
const hour = 2 * halfHour;
const pixelsPerMinute = 1.6;

function intersection(a: Interval, b: Interval): Interval {
  return { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) };
}
function span(row: TimeSpan, bounds: Interval) {
  return intersection({ start: Date.parse(row.start_at), end: Date.parse(row.end_at) }, bounds);
}
const valid = ({start,end}: Interval) => end > start;

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

function options(slot: Interval) {
  const choices: Interval[] = [];
  for (let start = slot.start; start < slot.end;) {
    const end = Math.min(slot.end, (Math.floor(start / halfHour) + 1) * halfHour);
    choices.push({start,end});
    start = end;
  }
  return choices;
}

function placeAppointments(rows: AppointmentSummary[], bounds: Interval) {
  type Event = {row: AppointmentSummary; interval: Interval; column: number; columns: number};
  const layout: Event[] = [];
  let active: Event[] = [];
  let laneEnds: number[] = [];
  function flush() {
    for (const event of active) layout.push({...event, columns:laneEnds.length});
    active = [];
    laneEnds = [];
  }
  const intervals = rows.map(row => ({row, interval: span(row,bounds)}))
    .filter(event => valid(event.interval)).sort((a,b) => a.interval.start - b.interval.start);
  for (const event of intervals) {
    if (laneEnds.every(end => end <= event.interval.start)) flush();
    const reusable = laneEnds.findIndex(end => end <= event.interval.start);
    const column = reusable < 0 ? laneEnds.length : reusable;
    laneEnds[column] = event.interval.end;
    active.push({...event,column,columns:1});
  }
  flush();
  return layout;
}

function label(time: number, dayEnd: number) {
  return time === dayEnd ? "24:00" : localTime(new Date(time).toISOString());
}

export function DaySchedule({ board, names, date, status, onAppointment, onCandidate, asOf = Date.now() }: {
  board: CalendarBoard; names: ReadonlyMap<string, string>; date: string; status: string;
  asOf?: number; onAppointment: (id: string) => void; onCandidate?: (selection: BookingPreference) => void;
}) {
  const bounds = { start: Date.parse(date + "T00:00:00+08:00"), end: Date.parse(addDays(date, 1) + "T00:00:00+08:00") };
  const published = board.shifts.filter(row => row.status === "PUBLISHED" && valid(span(row,bounds)));
  const appointments = board.appointments.filter(row => valid(span(row,bounds)));
  const dentists = [...new Set([...published, ...appointments].map(row => row.dentist_id))];
  if (!dentists.length) return <p>所选门店与日期暂无已发布班次或预约。</p>;
  const occupiedHours = [...published,...appointments].map(row => span(row,bounds));
  // Keep common daytime hours visible and extend for overnight or evening appointments.
  const start = Math.floor(Math.min(bounds.start + 8 * hour,...occupiedHours.map(row => row.start)) / hour) * hour;
  const end = Math.ceil(Math.max(bounds.start + 18 * hour,...occupiedHours.map(row => row.end)) / hour) * hour;
  const window = {start,end};
  const hours = Array.from({length:(end-start)/hour}, (_, index) => start + index * hour);
  const now = Math.ceil(asOf / minute) * minute;
  const range = (time: Interval) => label(time.start,bounds.end) + "–" + label(time.end,bounds.end);
  const pixels = (ms: number) => ms / minute * pixelsPerMinute;
  const position = (time: Interval) => ({top:pixels(time.start-start),height:pixels(time.end-time.start)});
  const blocked = (board.unavailable ?? []).map(block => span(block,window)).filter(valid);
  return <div className="appointment-day">
    <div className="appointment-day-key" aria-label="日历图例">
      <span data-key="booked">已有预约</span><span data-key="candidate">候选空档</span>
      <span data-key="off">未排班</span><span data-key="blocked">不可用</span>
    </div>
    <p className="muted">选择空档后，系统按主诊项目核对牙医资质、时长和牙椅。灰色区间不可预约。</p>
    <div className="appointment-timeline-scroll" aria-label="牙医预约日历" tabIndex={0}>
      <div className="appointment-timeline" style={{gridTemplateColumns:"64px repeat(" + dentists.length + ", minmax(160px,1fr))"}}>
        <div className="appointment-time-axis">
          <div className="appointment-track-head"><strong>时间</strong></div>
          <div className="appointment-track-slots" style={{height:pixels(end-start)}}>
            {hours.map(time => <time key={time} style={{top:pixels(time-start)}}>{label(time,bounds.end)}</time>)}
          </div>
        </div>
        {dentists.map(id => {
          const name = names.get(id) ?? "牙医 " + id;
          const shifts = published.filter(row => row.dentist_id === id).map(row => span(row,window));
          const rows = appointments.filter(row => row.dentist_id === id);
          const active = rows.filter(row => occupied.has(row.status)).map(row => span(row,window));
          const offDuty = remaining(window,shifts);
          const past = shifts.map(shift => intersection(shift,{start,end:now})).filter(valid);
          const closure = shifts.flatMap(shift => blocked.map(block => intersection(shift,block)).filter(valid));
          const slots = shifts.flatMap(shift => remaining({start:Math.max(shift.start,now),end:shift.end},[...active,...blocked]))
            .flatMap(options);
          const visible = placeAppointments(rows.filter(row => !status || row.status === status),window);
          return <section key={id} aria-label={name} className="appointment-track">
            <div className="appointment-track-head"><h3>{name}</h3>
              <span>{shifts.length ? shifts.map(range).join("、") : "无已发布班次"}</span>
            </div>
            <div className="appointment-track-slots" style={{height:pixels(end-start)}}>
              {offDuty.map(slot => <div key={slot.start} className="appointment-time-block" data-key="off" style={position(slot)}>
                <span>{range(slot)} · 未排班</span></div>)}
              {past.map(slot => <div key={slot.start} className="appointment-time-block" data-key="past" style={position(slot)}>
                <span>{range(slot)} · 已过</span></div>)}
              {closure.map(slot => <div key={slot.start} className="appointment-time-block" data-key="blocked" style={position(slot)}>
                <span>{range(slot)} · 牙椅不可用</span></div>)}
              {slots.map(slot => onCandidate
                ? <button type="button" key={slot.start} className="appointment-time-block appointment-time-candidate" style={position(slot)}
                    aria-label={range(slot) + " 候选空档"} onClick={() => onCandidate({dentistId:id,time:label(slot.start,bounds.end)})}>
                    <span>{label(slot.start,bounds.end)} · 候选空档</span>
                  </button>
                : <div key={slot.start} className="appointment-time-block appointment-time-candidate" style={position(slot)}>
                    <span>{label(slot.start,bounds.end)} · 候选空档</span>
                  </div>)}
              {visible.map(({row,interval,column,columns}) => <button key={row.appointment_id} type="button"
                className="appointment-time-block appointment-time-event" data-state={row.status}
                style={{...position(interval),left:"calc(" + column * 100 / columns + "% + 3px)",
                  width:"calc(" + 100 / columns + "% - 6px)"}} onClick={() => onAppointment(row.appointment_id)}>
                <strong>{row.patient_display ?? row.appointment_no}</strong>
                <span>{range(interval)} · {appointmentStates[row.status] ?? row.status}</span>
              </button>)}
              {now >= start && now < end && <div className="appointment-time-now" aria-hidden="true" style={{top:pixels(now-start)}} />}
            </div>
          </section>;
        })}
      </div>
    </div>
  </div>;
}
