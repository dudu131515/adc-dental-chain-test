import { type MouseEvent, useEffect, useRef, useState } from "react";
import { Brand, Icon } from "../src/shared/Icons";
import {
  type Appointment, type Clinic, type Status, appointments, clinics, days, funds, money, statusLabels,
} from "./fixtures";
import { OperationsDemo, OperationsOverview, SourceTable } from "./OperationsDemo";
import { AppointmentList, VisitDrawer } from "./AppointmentDetails";
import { AppointmentCalendar, ClinicResources, PatientWorkspace } from "./ClinicViews";
import { Billing, FinanceWorkspace, BusinessDirectory } from "./FinanceViews";
import { type Route, groups, routeFromHash } from "./workspace";

const states = Object.keys(statusLabels) as Status[];
const hours = [8,9,10,11,12,13,14,15,16,17];
const statusColors = ["#4774c2", "#cc8b3e", "#168880", "#51aa8d", "#9665ba", "#aebdca"];

function Dashboard({rows, onOpen, onCalendar}: {rows:Appointment[]; onCalendar:(event:MouseEvent<HTMLAnchorElement>)=>void; onOpen:(row:Appointment, button:HTMLButtonElement) => void}) {
  const [hour,setHour] = useState<number>();
  const counts = Object.fromEntries(states.map(status => [status,rows.filter(row => row.status === status).length])) as Record<Status,number>;
  const bars = hours.map(start => rows.filter(row => Number(row.time.slice(0,2)) === start).length);
  const max = Math.max(1,...bars);
  const metrics = [
    {label:"预约总数", amount:rows.length, icon:"calendar", color:"teal"},
    {label:"已签到", amount:counts.arrived, icon:"patients", color:"blue"},
    {label:"诊疗中", amount:counts.treating, icon:"activity", color:"gold"},
    {label:"已结束", amount:counts.done, icon:"check", color:"green"},
  ] as const;
  let boundary = 0;
  const stops = states.map((status,index) => {
    const start = boundary;
    boundary += (counts[status] / Math.max(1,rows.length)) * 100;
    return statusColors[index] + " " + start + "% " + boundary + "%";
  });
  const chart = rows.length ? "conic-gradient(" + stops.join(",") + ")" : "#e6edf1";
  const work = rows.some(row => row.status === "arrived" || row.status === "treating");
  const display = hour === undefined ? rows : rows.filter(row => Number(row.time.slice(0,2)) === hour);
  return <>
    <div className="pd-metrics">{metrics.map(metric => <article key={metric.label} className="pd-metric">
      <div><span>{metric.label}</span><strong>{metric.amount}<small> 笔</small></strong></div>
      <span className={"pd-metric-icon " + metric.color}><Icon name={metric.icon} size={21}/></span>
    </article>)}</div>
    <div className="pd-charts">
      <section className="pd-panel pd-volume" aria-labelledby="volume-title">
        <div className="pd-panel-title"><div><h2 id="volume-title">预约时段分布</h2><p>点击时段筛选下方日程</p></div>
          {hour !== undefined && <button className="pd-link" onClick={() => setHour(undefined)}>清除筛选</button>}</div>
        <div className="pd-bars">{bars.map((value,index) => <button key={hours[index]} type="button" className="pd-bar"
          aria-pressed={hour === hours[index]} aria-label={hours[index] + " 时，" + value + " 笔预约"}
          onClick={() => setHour(hour === hours[index] ? undefined : hours[index])}>
          <span className="pd-bar-track"><span style={{height: Math.max(value ? 9 : 1, (value/max)*100) + "%"}}><b>{value || ""}</b></span></span>
          <small>{String(hours[index]).padStart(2,"0")}:00</small></button>)}</div>
      </section>
      <section className="pd-panel pd-status-panel" aria-labelledby="status-title">
        <div className="pd-panel-title"><div><h2 id="status-title">履约状态</h2><p>所选门店和营业日</p></div></div>
        <div className="pd-status-content">
          <div className="pd-donut" style={{background:chart}} aria-hidden="true"><div><strong>{rows.length}</strong><small>预约</small></div></div>
          <dl className="pd-legend">{states.map((status,index) => <div key={status}>
            <dt><i style={{backgroundColor:statusColors[index]}}/>{statusLabels[status]}</dt><dd>{counts[status]}</dd>
          </div>)}</dl>
        </div>
      </section>
    </div>
    <section className="pd-panel" aria-labelledby="agenda-title">
      <div className="pd-panel-title"><div><h2 id="agenda-title">预约日程</h2><p>{hour === undefined ? "按预约时间排列" : hour + " 时的预约"}</p></div>
        <a href="#desk/calendar" onClick={onCalendar} className="pd-link">完整日历 {work && <><i className="pd-dot" aria-hidden="true"/><span className="sr-only">有待办</span></>}<Icon name="arrow" size={17}/></a>
      </div>
      <AppointmentList rows={display} onOpen={onOpen}/>
    </section>
  </>;
}



function HomeOverview({rows,date,clinic,open}:{
  rows:Appointment[]; date:string; clinic:Clinic|"all"; open:(event:MouseEvent<HTMLAnchorElement>,route:Route)=>void;
}) {
  const receipts=funds.filter(row=>row.date===date&&(clinic==="all"||row.clinic===clinic)&&row.kind!=="pending");
  const net=receipts.filter(row=>row.type==="treatment").reduce((sum,row)=>sum+(row.kind==="refund"?-row.value:row.value),0);
  const totals=[
    {label:"门诊运营",value:rows.length+" 笔",helper:"预约总量",icon:"calendar"},
    {label:"患者与诊疗",value:new Set(rows.map(row=>row.patient)).size+" 位",helper:"涉及患者",icon:"tooth"},
    {label:"收费与日结",value:money(net),helper:"诊疗净实收",icon:"receipt"},
    {label:"经营与配置",value:(clinic==="all"?2:1)+" 家",helper:"展示门店",icon:"chart"},
  ] as const;
  return <>
    <section className="pd-home-hero"><div><h2>安德鲁牙科连锁</h2><p>查看门店整体运行情况，再进入对应业务</p></div>
      <a className="pd-home-assistant" href="#operations/ai" onClick={event=>open(event,"operations/ai")}>
        <Icon name="activity" size={18}/>问经营助手<Icon name="arrow" size={16}/></a>
    </section>
    <div className="pd-metrics pd-compact-metrics">{totals.map(item=><article className="pd-metric" key={item.label}>
      <div><span>{item.label}</span><strong>{item.value}</strong><small>{item.helper}</small></div>
      <span className="pd-metric-icon"><Icon name={item.icon} size={19}/></span></article>)}</div>
    <section className="pd-panel"><div className="pd-panel-title"><div><h2>功能直达</h2></div></div>
      <div className="pd-home-links">{groups.map(group=><a key={group.id} href={"#"+group.tabs[0].id}
        onClick={event=>open(event,group.tabs[0].id)}><Icon name={group.icon} size={20}/><span><strong>{group.name}</strong>
          <small>{group.tabs.slice(0,3).map(item=>item.label).join(" · ")}</small></span><Icon name="chevron" size={16}/></a>)}</div>
    </section>
  </>;
}

export function PagesDemo() {
  const [route,setRoute] = useState(routeFromHash);
  const [clinic,setClinic] = useState<Clinic | "all">("all");
  const [date,setDate] = useState<(typeof days)[number]>(days[0]);
  const [selected,setSelected] = useState<{row:Appointment; bill:boolean}>();
  const trigger = useRef<HTMLButtonElement>(null);
  const active = groups.flatMap(group => group.tabs.map(tab => ({group,tab}))).find(item => item.tab.id === route);
  const group = active?.group;
  const tab = active?.tab;
  const [navOpen,setNavOpen] = useState(false);
  const [expanded,setExpanded] = useState<string>(()=>routeFromHash().split("/")[0]);
  function switchRoute(next:Route) {
    setRoute(next);
    setExpanded(next.split("/")[0]);
    setNavOpen(false);
    setSelected(undefined);
  }
  useEffect(() => {
    const sync = () => { if (window.location.hash !== "#demo-main") switchRoute(routeFromHash()); };
    window.addEventListener("hashchange",sync);
    window.addEventListener("popstate",sync);
    return () => {window.removeEventListener("hashchange",sync); window.removeEventListener("popstate",sync);};
  }, []);
  function open(event:MouseEvent<HTMLAnchorElement>, next: Route) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (route === next) return;
    window.history.pushState(null,"","#" + next);
    switchRoute(next);
    document.documentElement.scrollTop = 0;
  }
  function inspect(row:Appointment, button:HTMLButtonElement, bill=false) {
    trigger.current = button;
    setSelected({row,bill});
  }
  function dismiss() {
    setSelected(undefined);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  const scoped = appointments.filter(item => clinic === "all" || clinic === item.clinic);
  const rows = scoped.filter(item => item.date === date);
  const usesDate = group?.id !== "operations" && route !== "patients/directory";
  return <div className="pd-app">
    <a className="skip-link" href="#demo-main" onClick={event => {
      event.preventDefault(); document.getElementById("demo-main")?.focus();
    }}>跳至工作区</a>
    <aside className="pd-sidebar">
      <a className="pd-brand" href="#home" onClick={event => open(event,"home")} aria-label="ADC 首页"><Brand/></a>
      <button type="button" className="pd-mobile-nav" aria-expanded={navOpen} aria-controls="demo-workspace-tree"
        onClick={()=>setNavOpen(current=>!current)}><Icon name={navOpen?"close":"menu"} size={19}/>业务导航</button>
      <nav id="demo-workspace-tree" className="pd-tree" data-open={navOpen} aria-label="业务导航">
        <a href="#home" aria-current={route==="home"?"page":undefined} onClick={event=>open(event,"home")}>
          <Icon name="dashboard" size={19}/>首页</a>
        {groups.map(item => <div className="pd-tree-section" key={item.id}>
          <button className="pd-tree-heading" type="button" aria-expanded={expanded===item.id}
            aria-controls={"demo-group-"+item.id} onClick={()=>setExpanded(expanded===item.id?"":item.id)}>
            <Icon name={item.icon} size={19}/>{item.name}<Icon name="chevron" size={15}/>
          </button>
          <ul hidden={expanded!==item.id} id={"demo-group-"+item.id} aria-label={item.name+"子功能"}>
            {item.tabs.map(child=><li key={child.id}><a href={"#"+child.id} aria-current={route===child.id?"page":undefined}
              onClick={event=>open(event,child.id)}>{child.label}</a></li>)}
          </ul>
        </div>)}
      </nav>
      <div className="pd-rail-footer"><Icon name="clinic" size={19}/><span>安德鲁牙科连锁</span></div>
    </aside>
    <div className="pd-content">
      <header className="pd-top"><div><span>管理中心</span><b>/</b>{group?.name ?? "首页"}</div>
        <span className="pd-demo"><i aria-hidden="true"/>合成演示</span>
      </header>
      <main className="pd-main" id="demo-main" tabIndex={-1}>
        <div className="pd-heading"><div><h1>{tab?.title ?? "运营首页"}</h1>
          {usesDate && <p>{(clinic === "all" ? "两家门店" : clinics[clinic]) + " · " + date}</p>}</div>
          {(usesDate || route === "patients/directory" || route === "operations/overview") && <div className="pd-filters">
            <label>门店<select value={clinic} onChange={event => setClinic(event.target.value as Clinic | "all")}>
              <option value="all">全部门店</option>{Object.entries(clinics).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            {usesDate && <label>业务日期<select value={date} onChange={event => setDate(event.target.value as (typeof days)[number])}>
              {days.map(day => <option value={day} key={day}>{day}</option>)}</select></label>}
          </div>}
        </div>
        {route === "home" && <HomeOverview rows={rows} date={date} clinic={clinic} open={open}/>}
        {route === "desk/home" && <Dashboard key={clinic+date} rows={rows} onOpen={inspect} onCalendar={event=>open(event,"desk/calendar")}/>}
        {route === "desk/calendar" && <AppointmentCalendar key={clinic+date} rows={rows} clinic={clinic} onOpen={inspect}/>}
        {(route === "desk/staff" || route === "desk/chairs") && <ClinicResources route={route} date={date} rows={rows} clinic={clinic}/>}
        {group?.id === "patients" && <PatientWorkspace key={route} route={route} rows={rows} scoped={scoped} onOpen={inspect}/>}
        {route === "billing/reconcile" && <Billing date={date} clinic={clinic}/>}
        {group?.id === "billing" && route!=="billing/reconcile" && <FinanceWorkspace key={route} route={route} rows={rows} clinic={clinic} onOpen={inspect}/>}
        {route === "operations/overview" && <OperationsOverview clinic={clinic}/>}
        {route === "operations/compare" && <SourceTable title="两店样例指标"/>}
        {route === "operations/ai" && <OperationsDemo/>}
        {["operations/quarter","operations/catalog","operations/access"].includes(route) && <BusinessDirectory route={route}/>}
      </main>
    </div>
    {selected && <VisitDrawer visit={selected.row} initialBill={selected.bill} dismiss={dismiss}/>}
  </div>;
}
