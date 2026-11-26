import { useState } from "react";
import { Icon } from "../src/shared/Icons";
import { canWorkAt, type StaffIdentity } from "../src/shared/navigation";
import { useRead } from "../src/shared/useRead";
import { DaySchedule, type BookingPreference, type CalendarBoard } from "../src/features/schedule/DaySchedule";
import { BookingForm } from "../src/features/schedule/BookingForm";
import { ScheduleDrawer } from "../src/features/schedule/AppointmentDrawer";
import { AppointmentList, StatusBadge } from "./AppointmentDetails";
import { type Appointment, type Clinic, type Status, chairs, clinics, days, staffShifts, statusLabels } from "./fixtures";
import type { Route } from "./workspace";

type Inspect = (row:Appointment, button:HTMLButtonElement) => void;
type Scope = {rows:Appointment[]; clinic:Clinic|"all"};

export function AppointmentCalendar({rows,clinic,onOpen,date,identity,visitor,onAppointment}: Scope & {
  onOpen:Inspect; date: (typeof days)[number]; identity: StaffIdentity; visitor: boolean; onAppointment: (id: string) => void;
}) {
  const [mode,setMode]=useState<"chair"|"doctor"|"list">("doctor");
  const [status,setStatus]=useState<Status|"all">("all");
  const [query,setQuery]=useState("");
  const [booking, setBooking] = useState<BookingPreference>();
  const [revision, setRevision] = useState(0);
  const boardQuery = new URLSearchParams({clinic_id:clinic,date_from:date,date_to:date,view:"day"});
  const showDay = clinic !== "all" && mode === "doctor" && !query.trim();
  const board = useRead<CalendarBoard>(showDay ? "/schedule/board?" + boardQuery : undefined, revision);
  const dentists = useRead<{items:{dentist_id:string;name:string}[]}>(showDay ? "/schedule/dentists?clinic_id=" + clinic : undefined);
  const names = new Map(dentists.data?.items.map(item => [item.dentist_id,item.name]));
  const mayBook = clinic !== "all" && (visitor || canWorkAt(identity,"FRONT_DESK",clinic));
  const statusCodes = {all:"",booked:"CONFIRMED",arrived:"CHECKED_IN",treating:"IN_TREATMENT",
    done:"COMPLETED",missed:"NO_SHOW",cancelled:"CANCELLED"};
  const scopedChairs=chairs.filter(item=>clinic==="all"||item.clinic===clinic);
  const columns=mode==="chair"
    ? scopedChairs.map(item=>({id:item.code,title:item.code,description:clinics[item.clinic]+" · "+item.room}))
    : scopedChairs.filter(item=>item.doctor).map(item=>({id:item.doctor,title:item.doctor,description:clinics[item.clinic]}));
  const selected=rows.filter(row=>(status==="all"||row.status===status)&&
    (row.patient+row.id+row.service+row.doctor).toLowerCase().includes(query.trim().toLowerCase()));
  const grouped=selected.reduce<Record<string,Appointment[]>>((byHour,row)=>{
    (byHour[row.time.slice(0,2)]??=[]).push(row);
    return byHour;
  },{});
  function columnFor(row:Appointment) {
    return mode==="doctor" ? row.doctor : scopedChairs.find(item=>item.doctor===row.doctor&&item.clinic===row.clinic)?.code;
  }
  return <section className="pd-panel" aria-label="预约排程">
    <div className="pd-panel-title"><div><h2>当日排程</h2><p>{selected.length} 笔符合筛选</p></div>
      <div className="pd-segments" aria-label="排程视图">
        {([["doctor","按牙医"],["chair","按牙椅"],["list","列表"]] as const).map(([value,label])=>
          <button key={value} aria-pressed={mode===value} onClick={()=>setMode(value)}>{label}</button>)}</div></div>
    <div className="pd-filter-row">
      <label className="pd-search">搜索预约<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="姓名、项目、预约号"/></label>
      <label className="pd-search">预约状态<select value={status} onChange={event=>setStatus(event.target.value as Status|"all")}>
        <option value="all">全部状态</option>{Object.entries(statusLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </select></label>
    </div>
    {showDay && board.loading && <p role="status">正在读取排班示例…</p>}
    {showDay && board.fault && <p role="alert">{board.fault}</p>}
    {showDay && board.data && <DaySchedule board={board.data} names={names} date={date} asOf={Date.parse(date + "T07:00:00+08:00")}
      status={statusCodes[status]} onAppointment={onAppointment} onCandidate={mayBook ? setBooking : undefined}/>}
    {mode!=="chair" ? ((!showDay || !board.data) && <AppointmentList rows={selected} onOpen={onOpen}/>) : <div className="pd-table-wrap pd-calendar-wrap">
      <table className="pd-table pd-calendar"><thead><tr><th scope="col">时间</th>{columns.map(column=>
        <th scope="col" key={column.id}><strong>{column.title}</strong><small>{column.description}</small></th>)}</tr></thead>
        <tbody>{Array.from({length:10},(_,i)=>String(i+8).padStart(2,"0")).map(hour=><tr key={hour}>
          <th scope="row">{hour}:00</th>{columns.map(column=><td key={column.id}>
          {(grouped[hour]??[]).filter(row=>columnFor(row)===column.id).map(row=><button key={row.id} data-status={row.status}
            className="pd-event" onClick={event=>onOpen(row,event.currentTarget)}>
            <span>{row.time}<strong>{row.patient}</strong></span><small>{row.service} · {statusLabels[row.status]}</small></button>)}
        </td>)}</tr>)}</tbody></table></div>}
    {mode==="chair" && selected.length===0 && <p className="pd-empty">所选范围没有预约。</p>}
    {booking && mayBook && <ScheduleDrawer title="代办预约" onClose={() => setBooking(undefined)}>
      <BookingForm identity={identity} clinic={clinic} date={date} preference={booking} onAppointment={id => {
        setBooking(undefined); setRevision(value => value + 1); onAppointment(id);
      }}/>
    </ScheduleDrawer>}
  </section>;
}

export function ClinicResources({route,date,rows,clinic}: Scope & {route:Route;date:(typeof days)[number]}) {
  const scope=(office:Clinic)=>clinic==="all"||clinic===office;
  if(route==="desk/staff") {
    const shifts=staffShifts.filter(shift=>scope(shift.clinic)&&shift.date===date);
    return <section className="pd-panel"><div className="pd-panel-title"><div><h2>当日班次</h2>
      <p>{shifts.filter(row=>row.status==="已发布").length} 个已发布班次</p></div>
      <a className="pd-link" href="#desk/calendar">查看预约日历<Icon name="arrow" size={17}/></a></div>
      <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th>牙医</th><th>门店</th><th>班次时段</th><th>发布状态</th></tr></thead>
      <tbody>{shifts.map(item=><tr key={item.doctor+item.clinic}><th scope="row">{item.doctor}</th><td>{clinics[item.clinic]}</td>
        <td>{item.time}</td><td><span className="pd-status" data-status={item.status==="已发布"?"done":"arrived"}>{item.status}</span></td>
      </tr>)}</tbody></table></div>{!shifts.length&&<p className="pd-empty">所选门店和日期没有班次。</p>}</section>;
  }
  return <section className="pd-panel"><div className="pd-panel-title"><div><h2>诊室与牙椅</h2><p>查看当日排程占用和可用资源</p></div>
    <a href="#desk/calendar" className="pd-link">查看预约日历<Icon name="arrow" size={17}/></a></div><div className="pd-resource-cards">
    {chairs.filter(item=>scope(item.clinic)).map(item=>{
      const assigned=rows.filter(row=>row.doctor===item.doctor&&row.clinic===item.clinic&&row.status!=="cancelled"&&row.status!=="missed");
      const active=assigned.some(row=>row.status==="treating");
      return <article key={item.code}><header><Icon name="tooth" size={19}/><strong>{item.code}</strong>
        <span className="pd-status" data-status={active?"treating":"done"}>{active?"使用中":"当日可用"}</span></header>
        <p>{clinics[item.clinic]} · {item.room}</p><dl><div><dt>椅型</dt><dd>{item.type}</dd></div>
          <div><dt>当日预约</dt><dd>{assigned.length} 笔</dd></div></dl></article>;
    })}
  </div></section>;
}

export function PatientWorkspace({route,rows,scoped,onOpen}: {route:Route;rows:Appointment[];scoped:Appointment[];onOpen:Inspect}) {
  const [query,setQuery]=useState("");
  const [allergy,setAllergy]=useState(false);
  const isDirectory=route==="patients/directory";
  const isQueue=route==="patients/queue";
  const directory=[...new Map([...scoped].sort((a,b)=>a.date.localeCompare(b.date)).map(
    row=>[row.clinic + ":" + row.patientId,row],
  )).values()].sort((a,b)=>a.patient.localeCompare(b.patient,"zh-CN"));
  const relevant=isDirectory ? directory : rows.filter(row=>row.status==="treating"||row.status===(isQueue?"arrived":"done"));
  const matches=relevant.filter(row=>(!allergy||row.allergy)&&
    (row.patient+row.id+row.doctor+row.service).toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="pd-panel">
    <div className="pd-panel-title"><div><h2>{isDirectory?"患者目录":isQueue?"候诊与诊疗中":"就诊与诊疗记录"}</h2>
      <p>{relevant.length} {isDirectory?"位患者":"笔就诊"}</p></div>
      <div className="pd-filter-row">
        <label className="pd-search">搜索<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="姓名、预约号、项目"/></label>
        <label className="pd-check"><input type="checkbox" checked={allergy} onChange={event=>setAllergy(event.target.checked)}/>已知过敏</label>
      </div>
    </div>
    {isQueue&&matches.length ? <div className="pd-queue">{(["arrived","treating"] as const).map(state=><section key={state}>
      <h3>{statusLabels[state]} <span>{matches.filter(row=>row.status===state).length}</span></h3>
      {matches.filter(row=>row.status===state).map(row=><button className="pd-queue-card" key={row.id} onClick={event=>onOpen(row,event.currentTarget)}>
        <span>{row.time} <strong>{row.patient}</strong> <Icon name="chevron" size={15}/></span><small>{row.service} · {row.doctor}</small>
        {row.allergy && <span className="pd-allergy">已知过敏</span>}</button>)}
    </section>)}</div> : <AppointmentList rows={matches} onOpen={onOpen} patients={isDirectory}/>}
  </section>;
}
