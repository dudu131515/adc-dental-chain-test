import { FormEvent, useState } from "react";
import { canWorkAt, WorkArea } from "../../shared/AppShell";
import { useRead } from "../../shared/useRead";
import { AppointmentDrawer, ScheduleDrawer } from "./AppointmentDrawer";
import { Appointment, appointmentStates } from "./appointmentTypes";
import { BookingForm, type Patient } from "./BookingForm";
import { addDays, localDate, localTime } from "./types";

function status(row: Appointment) {
  return row.status === "CHECKED_IN" && "chair" in row && !row.chair ? "已签到 · 待分椅" : appointmentStates[row.status] ?? row.status;
}

export function AppointmentCalendar({ identity, clinicId, path, open }: WorkArea) {
  const params = new URLSearchParams(window.location.search);
  const [date, setDate] = useState(params.get("date") || localDate(new Date()));
  const [clinic, setClinic] = useState(clinicId || params.get("clinic") || "");
  const [dentist, setDentist] = useState(params.get("dentist") || "");
  const [state, setState] = useState(params.get("status") || "");
  const [list, setList] = useState(params.get("layout") === "list");
  const [lookup, setLookup] = useState("");
  const patientId = params.get("patient");
  const [booking, setBooking] = useState(params.get("action") === "book");
  const [sequence, setSequence] = useState(0);
  const criteria = new URLSearchParams({ date });
  if (clinic) criteria.set("clinic_id", clinic);
  if (dentist) criteria.set("dentist_id", dentist);
  if (state) criteria.set("status", state);
  const read = useRead<{ items: Appointment[] }>("/appointments?" + criteria, sequence);
  const dentists = useRead<{ items: { dentist_id: string; name: string }[] }>("/schedule/dentists" + (clinic ? "?clinic_id=" + clinic : ""));
  const activeId = path.match(/^\/schedule\/appointments\/(\d+)$/)?.[1];
  const rows = read.data?.items ?? [];
  const doctors = [...new Map(rows.map(row => [row.dentist.dentist_id, row.dentist.name]))];
  const times = [...new Set(rows.map(row => localTime(row.start_at)))].sort();
  const frontClinics = identity.clinics.filter(item => canWorkAt(identity, "FRONT_DESK", item.clinic_id));
  const mayBook = Boolean(clinic && frontClinics.some(item => item.clinic_id === clinic));
  const canHandover = ["FRONT_DESK", "CLINIC_MANAGER", "HQ_SCHEDULER"].some(role => identity.capabilities.includes(role));

  const linkedPatient = useRead<{ patient: Patient }>(booking && mayBook && patientId && /^\d+$/.test(patientId)
    ? "/clinics/" + clinic + "/patients/" + patientId : undefined);
  function closeBooking() { setBooking(false); save("action", ""); save("patient", ""); }

  function save(key: string, value: string) {
    const query = new URLSearchParams(window.location.search);
    if (value) query.set(key, value); else query.delete(key);
    window.history.replaceState(window.history.state, "", window.location.pathname + "?" + query);
  }
  function pickDate(next: string) { if (next) { setDate(next); save("date", next); } }
  function go(target: string) { open(target + window.location.search); }
  function openAppointment(id: string) { closeBooking(); go("/schedule/appointments/" + id); }
  function handover(event: FormEvent) { event.preventDefault(); if (/^[0-9]+$/.test(lookup)) openAppointment(lookup); }

  function tile(row: Appointment) {
    return <button className="shift-slot appointment-tile" onClick={() => openAppointment(row.appointment_id)}>
      <strong>{row.patient_display?.name ?? row.appointment_no}</strong>
      <span>{localTime(row.start_at)}–{localTime(row.end_at)} · {row.treatment.name}</span>
      <span>{row.clinic.name}</span>
      <span className="status-tag" data-state={row.status}>{status(row)}</span>
    </button>;
  }

  return <section className="schedule-panel">
    <div className="schedule-heading"><h2>预约日历</h2>
      <div className="schedule-toolbar">
        <button className="button" onClick={() => pickDate(addDays(date, -1))}>前一天</button>
        <button className="button" onClick={() => pickDate(localDate(new Date()))}>今天</button>
        <button className="button" onClick={() => pickDate(addDays(date, 1))}>后一天</button>
        <button className="button" aria-pressed={!list} onClick={() => { setList(false); save("layout", "grid"); }}>日历</button>
        <button className="button" aria-pressed={list} onClick={() => { setList(true); save("layout", "list"); }}>列表</button>
      </div>
    </div>
    <div className="schedule-form">
      <label>日期<input type="date" value={date} onChange={event => pickDate(event.target.value)} /></label>
      <label>门店筛选<select value={clinic} onChange={event => {
        setClinic(event.target.value); setDentist(""); save("clinic", event.target.value); save("dentist", "");
      }}>
        <option value="">全部授权门店</option>{identity.clinics.map(item => <option key={item.clinic_id} value={item.clinic_id}>{item.name}</option>)}
      </select></label>
      <label>牙医筛选<select value={dentist} onChange={event => { setDentist(event.target.value); save("dentist", event.target.value); }}>
        <option value="">全部牙医</option>{dentists.data?.items.map(item => <option key={item.dentist_id} value={item.dentist_id}>{item.name}</option>)}
      </select></label>
      <label>履约状态<select value={state} onChange={event => { setState(event.target.value); save("status", event.target.value); }}>
        <option value="">全部状态</option>{Object.entries(appointmentStates).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {mayBook && <button className="button primary" onClick={() => setBooking(true)}>代办预约</button>}
      {!mayBook && frontClinics.length > 0 && <span className="muted">选择具备前台权限的门店后可代办预约。</span>}
    </div>
    {read.loading && <p role="status">正在读取日程…</p>}
    {(read.fault || dentists.fault) && <p className="error-text" role="alert">{read.fault || dentists.fault}</p>}
    {read.data && !rows.length && <p>当前日期与筛选范围暂无预约。</p>}
    {!!rows.length && (list ? <ul className="compact-list">{rows.map(row => <li key={row.appointment_id}>
      {tile(row)}<span>{row.dentist.name}</span>
    </li>)}</ul> : <div className="schedule-scroll"><table className="shift-grid appointment-grid">
      <thead><tr><th scope="col">预约开始</th>{doctors.map(([id, label]) => <th key={id} scope="col">{label}</th>)}</tr></thead>
      <tbody>{times.map(time => <tr key={time}><th scope="row">{time}</th>{doctors.map(([id]) => <td key={id}>
        {rows.filter(row => row.dentist.dentist_id === id && localTime(row.start_at) === time).map(row =>
          <div key={row.appointment_id}>{tile(row)}</div>)}
      </td>)}</tr>)}</tbody>
    </table></div>)}
    {canHandover && <details>
      <summary>回查原店交接</summary>
      <form className="schedule-form" onSubmit={handover}>
        <label>预约记录号<input required inputMode="numeric" pattern="[0-9]+" value={lookup} onChange={event => setLookup(event.target.value)} /></label>
        <button className="button">查看交接</button>
      </form>
    </details>}
    {booking && mayBook && <ScheduleDrawer title="代办预约" onClose={closeBooking}>
      {linkedPatient.loading && <p role="status">正在核对患者档案…</p>}
      {linkedPatient.fault && <p role="alert">{linkedPatient.fault}</p>}
      {(!patientId || linkedPatient.data) && <BookingForm key={clinic + ":" + date + ":" + (patientId || "")} identity={identity} clinic={clinic} date={date} initialPatient={linkedPatient.data?.patient} onAppointment={openAppointment} />}
    </ScheduleDrawer>}
    {activeId && !booking && <AppointmentDrawer key={activeId} id={activeId} identity={identity} open={open}
      onClose={() => go("/schedule")} onChange={() => setSequence(value => value + 1)} />}
  </section>;
}
