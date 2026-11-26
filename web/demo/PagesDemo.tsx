import { useEffect, useRef, useState } from "react";
import { Brand, Icon } from "../src/shared/Icons";
import {
  type Appointment, type Clinic, type Status, appointments, clinics, days, funds, invoices, money, statusLabels,
} from "./fixtures";
import { OperationsDemo } from "./OperationsDemo";

const navigation = [
  {key:"desk", label:"工作台", icon:"dashboard"},
  {key:"schedule", label:"排班与预约", icon:"calendar"},
  {key:"patients", label:"患者与诊疗", icon:"tooth"},
  {key:"billing", label:"收费与日结", icon:"receipt"},
  {key:"operations", label:"经营分析", icon:"chart"},
] as const;
type Route = (typeof navigation)[number]["key"];
const states = Object.keys(statusLabels) as Status[];
const hours = [8,9,10,11,12,13,14,15,16,17];
const statusColors = ["#4774c2", "#cc8b3e", "#168880", "#51aa8d", "#9665ba", "#aebdca"];

function routeFromHash(): Route {
  return navigation.find(item => "#" + item.key === window.location.hash)?.key ?? "desk";
}

function StatusBadge({status}: {status:Status}) {
  return <span className="pd-status" data-status={status}><i aria-hidden="true"/>{statusLabels[status]}</span>;
}

function AppointmentList({rows, onOpen, patients = false}: {
  rows: Appointment[]; onOpen: (row:Appointment, button:HTMLButtonElement) => void; patients?:boolean;
}) {
  return rows.length ? <div className="pd-table-wrap"><table className="pd-table">
    <thead><tr><th scope="col">{patients ? "患者姓名" : "预约时间"}</th><th scope="col">{patients ? "过敏标记" : "患者姓名"}</th>
      <th scope="col">项目</th><th scope="col">门店</th><th scope="col">履约状态</th><th scope="col">详情</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>
      <th scope="row">{patients ? row.patient : row.time}</th>
      <td>{patients ? row.allergy ? <span className="pd-allergy">已知过敏</span> : "待核实" : <>
        {row.patient}{row.allergy && <span className="pd-allergy" title="合成过敏标记">过敏</span>}
      </>}</td>
      <td>{row.service}</td><td>{clinics[row.clinic]}</td><td><StatusBadge status={row.status}/></td>
      <td><button className="pd-link" onClick={event => onOpen(row, event.currentTarget)} aria-label={"查看 " + row.patient + " 预约详情"}>
        查看<Icon name="chevron" size={14}/></button></td>
    </tr>)}</tbody>
  </table></div> : <p className="pd-empty">当前门店和日期没有符合条件的记录。</p>;
}

function VisitDrawer({visit, dismiss}: {visit: Appointment; dismiss: () => void}) {
  const ref = useRef<HTMLDialogElement>(null);
  const invoice = visit.invoice ? invoices[visit.invoice as keyof typeof invoices] : undefined;
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  }, []);
  return <dialog className="pd-drawer" ref={ref} aria-label="预约详情"
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <div className="pd-drawer-body">
      <header><div><span className="pd-id">{visit.id}</span><h2>预约详情</h2></div>
        <button type="button" className="pd-icon-button" aria-label="关闭详情" onClick={dismiss}><Icon name="close" size={21}/></button></header>
      <div className="pd-visit-title"><h3>{visit.patient}</h3><StatusBadge status={visit.status}/></div>
      <dl className="pd-facts"><div><dt>门店</dt><dd>{clinics[visit.clinic]}</dd></div>
        <div><dt>预约时间</dt><dd>{visit.date} {visit.time}</dd></div>
        <div><dt>诊疗项目</dt><dd>{visit.service}</dd></div><div><dt>责任牙医</dt><dd>{visit.doctor}</dd></div></dl>
      <section className={"pd-allergy-box" + (visit.allergy ? " has-allergy" : "")}>
        <h3>过敏核对</h3><p>{visit.allergy ? <><span>已知过敏</span><strong>{visit.allergy}</strong></> : "待核实"}</p>
      </section>
      {invoice && <section className="pd-invoice"><h3>诊疗费用单</h3><p>{visit.invoice} · {invoice.status}</p>
        <dl className="pd-facts"><div><dt>当前应缴</dt><dd>{money(invoice.due)}</dd></div>
          <div><dt>成功收款</dt><dd>{money(invoice.received)}</dd></div>
          <div><dt>成功退款</dt><dd>{money(invoice.refunded)}</dd></div>
          <div><dt>欠款</dt><dd>{money(invoice.outstanding)}</dd></div></dl>
      </section>}
    </div>
  </dialog>;
}

function Dashboard({rows, onOpen}: {rows:Appointment[]; onOpen:(row:Appointment, button:HTMLButtonElement) => void}) {
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
        <a href="#schedule" className="pd-link">完整日历 {work && <><i className="pd-dot" aria-hidden="true"/><span className="sr-only">有待办</span></>}<Icon name="arrow" size={17}/></a>
      </div>
      <AppointmentList rows={display} onOpen={onOpen}/>
    </section>
  </>;
}

function Billing({date, clinic}: {date:(typeof days)[number]; clinic:Clinic | "all"}) {
  const rows = funds.filter(fund => fund.date === date && (clinic === "all" || clinic === fund.clinic));
  function show(kind:"received" | "refund" | "pending", type?: "deposit" | "treatment") {
    return rows.filter(row => row.kind === kind && (!type || row.type === type)).reduce((sum,row) => sum+row.value,0);
  }
  return <section className="pd-panel">
    <div className="pd-panel-title"><div><h2>营业日对账</h2><p>模拟资金按成功回执归集</p></div></div>
    <div className="pd-table-wrap"><table className="pd-table"><thead><tr>
      <th scope="col">资金分类</th><th scope="col">成功实收</th><th scope="col">成功退回</th><th scope="col">净额</th>
    </tr></thead><tbody>{(["deposit","treatment"] as const).map(type => <tr key={type}>
      <th scope="row">{type === "deposit" ? "预约金" : "诊疗款"}</th><td>{money(show("received",type))}</td>
      <td>{money(show("refund",type))}</td><td>{money(show("received",type)-show("refund",type))}</td>
    </tr>)}</tbody></table></div>
    <div className="pd-panel-title pd-ledger-title"><div><h2>资金流水</h2><p>当前在途 {money(show("pending"))}</p></div></div>
    {rows.length ? <div className="pd-table-wrap"><table className="pd-table"><thead><tr>
      <th scope="col">时间</th><th scope="col">原单据</th><th scope="col">门店</th><th scope="col">类型</th><th scope="col">金额</th>
    </tr></thead><tbody>{rows.map(row => <tr key={row.id+row.label}>
      <td>{row.time}</td><th scope="row">{row.id}</th><td>{clinics[row.clinic]}</td><td>{row.label}</td><td>{money(row.value)}</td>
    </tr>)}</tbody></table></div> : <p className="pd-empty">所选门店和日期没有模拟资金记录。</p>}
  </section>;
}

export function PagesDemo() {
  const [route,setRoute] = useState(routeFromHash);
  const [clinic,setClinic] = useState<Clinic | "all">("all");
  const [date,setDate] = useState<(typeof days)[number]>(days[0]);
  const [selected,setSelected] = useState<Appointment>();
  const [query,setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const sync = () => {setRoute(routeFromHash()); setQuery(""); setSelected(undefined);};
    window.addEventListener("hashchange",sync);
    window.addEventListener("popstate",sync);
    return () => {window.removeEventListener("hashchange",sync); window.removeEventListener("popstate",sync);};
  }, []);
  function open(next: Route) {
    if (route === next) return;
    window.history.pushState(null,"","#" + next);
    setRoute(next); setQuery(""); setSelected(undefined);
    document.documentElement.scrollTop = 0;
  }
  function inspect(row:Appointment, button:HTMLButtonElement) { trigger.current = button; setSelected(row); }
  function dismiss() {
    setSelected(undefined);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  const rows = appointments.filter(item => item.date === date && (clinic === "all" || clinic === item.clinic));
  const headings = {desk:"门诊工作台",schedule:"排班与预约",patients:"患者与诊疗",billing:"收费与日结",operations:"经营分析"};
  return <div className="pd-app">
    <a className="skip-link" href="#demo-main">跳至工作区</a>
    <aside className="pd-sidebar">
      <a className="pd-brand" href="#desk" onClick={event => {event.preventDefault();open("desk");}} aria-label="ADC 工作台"><Brand/></a>
      <nav aria-label="业务导航">{navigation.map(item => <a key={item.key} href={"#" + item.key}
        aria-current={route === item.key ? "page" : undefined}
        onClick={event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); open(item.key);
        }}><Icon name={item.icon} size={19}/><span>{item.label}</span></a>)}</nav>
      <div className="pd-rail-footer"><Icon name="clinic" size={19}/><span>安德鲁牙科连锁</span></div>
    </aside>
    <div className="pd-content">
      <header className="pd-top"><div><span>管理中心</span><b>/</b>{navigation.find(item => item.key === route)?.label}</div>
        <span className="pd-demo"><i aria-hidden="true"/>合成演示</span>
      </header>
      <main className="pd-main" id="demo-main" tabIndex={-1}>
        <div className="pd-heading"><div><h1>{headings[route]}</h1>
          <p>{route === "operations" ? "双店预约履约与诊疗资金" : (clinic === "all" ? "两家门店" : clinics[clinic]) + " · " + date}</p></div>
          {route !== "operations" && <div className="pd-filters">
            <label>门店<select value={clinic} onChange={event => setClinic(event.target.value as Clinic | "all")}>
              <option value="all">全部门店</option>{Object.entries(clinics).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>业务日期<select value={date} onChange={event => setDate(event.target.value as (typeof days)[number])}>
              {days.map(day => <option value={day} key={day}>{day}</option>)}</select></label>
          </div>}
        </div>
        {route === "desk" && <Dashboard key={clinic+date} rows={rows} onOpen={inspect}/>}
        {(route === "schedule" || route === "patients") && <section className="pd-panel">
          <div className="pd-panel-title"><div><h2>{route === "schedule" ? "预约日历" : "当日患者"}</h2><p>{rows.length} 笔预约</p></div>
            <label className="pd-search">搜索<input value={query} onChange={event => setQuery(event.target.value)} placeholder="患者姓名或预约号"/></label></div>
          <AppointmentList rows={rows.filter(row => (row.patient + row.id).toLowerCase().includes(query.trim().toLowerCase()))}
            onOpen={inspect} patients={route === "patients"}/>
        </section>}
        {route === "billing" && <Billing date={date} clinic={clinic}/>}
        {route === "operations" && <OperationsDemo/>}
      </main>
    </div>
    {selected && <VisitDrawer visit={selected} dismiss={dismiss}/>}
  </div>;
}
