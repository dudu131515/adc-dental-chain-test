import { useState } from "react";
import type { WorkArea } from "../../shared/AppShell";
import { Icon, IconName } from "../../shared/Icons";
import { localDay } from "../../shared/format";
import { dailyRoles, hasRole, performanceRoles } from "../../shared/navigation";
import { useRead } from "../../shared/useRead";
import { Appointment, appointmentStates } from "../schedule/appointmentTypes";
import { localTime } from "../schedule/types";
import type { Period } from "../operations/ExpensesPage";
import { versionStates } from "../operations/VersionComparison";
import "./dashboard.css";

type Shortcut = { label: string; description: string; path: string; icon: IconName; roles: string[] };
const shortcuts: Shortcut[] = [
  {label:"患者档案", description:"建档与预约记录", path:"/patients", icon:"patients", roles:["FRONT_DESK"]},
  {label:"结算队列", description:"开单与收退办理", path:"/billing", icon:"receipt", roles:["FRONT_DESK"]},
  {label:"接诊队列", description:"开始或继续诊疗", path:"/clinical", icon:"tooth", roles:["DENTIST"]},
  {label:"跨店排班", description:"查看班次与回应", path:"/schedule?view=shifts", icon:"calendar", roles:["CLINIC_MANAGER","HQ_SCHEDULER","DENTIST"]},
  {label:"排班需求", description:"查看门店用人需求", path:"/schedule?view=demands", icon:"layers", roles:["CLINIC_MANAGER","HQ_SCHEDULER"]},
  {label:"更正与审批", description:"核对就诊更正", path:"/billing/corrections", icon:"check", roles:["CLINIC_MANAGER","DENTIST"]},
  {label:"费用登记", description:"核对门店运营费用", path:"/operations/expenses", icon:"receipt", roles:["CLINIC_MANAGER"]},
  {label:"项目与价格", description:"维护标准与价格版本", path:"/catalog", icon:"catalog", roles:["HQ_CATALOG"]},
  {label:"经营报告", description:"查询指标及来源", path:"/operations/report", icon:"chart", roles:["HQ_OPERATIONS_QUERY"]},
  {label:"季度核算", description:"查看季度与历史版本", path:"/operations/quarters", icon:"layers", roles:performanceRoles},
];

function WorkLinks({identity, clinicId, open}: WorkArea) {
  const links = shortcuts.filter(item => hasRole(identity, item.roles, clinicId));
  if (!links.length) return <section className="desk-panel"><h2>岗位业务</h2><p>当前账号暂无已授权业务。</p></section>;
  return <section className="desk-panel"><div className="desk-panel-head"><h2>快捷办理</h2></div>
    <div className="desk-links">{links.map(item => <button key={item.path} onClick={() => open(item.path)}>
      <span className="desk-link-symbol"><Icon name={item.icon}/></span><span><strong>{item.label}</strong><small>{item.description}</small></span>
      <Icon name="chevron" size={15}/></button>)}</div>
  </section>;
}
type Tile = {label: string; status: string; description: string; icon: IconName; color: string};
const tiles: Tile[] = [
  {label:"预约总数", status:"", description:"含所选日全部履约状态", icon:"calendar", color:"green"},
  {label:"待到诊", status:"CONFIRMED", description:"预约已确认，尚未签到", icon:"clock", color:"amber"},
  {label:"已签到", status:"CHECKED_IN", description:"已到店，等待接诊", icon:"patients", color:"blue"},
  {label:"诊疗中", status:"IN_TREATMENT", description:"已开始本次诊疗", icon:"activity", color:"violet"},
];
const stateOrder = ["CONFIRMED","CHECKED_IN","IN_TREATMENT","COMPLETED","CANCELLED","NO_SHOW"];
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai",year:"numeric",month:"long",day:"numeric",weekday:"long"});
function DaySchedule({area, day, revision}: {area: WorkArea; day: string; revision:number}) {
  const query = new URLSearchParams({date: day});
  if (area.clinicId) query.set("clinic_id", area.clinicId);
  const source = useRead<{items: Appointment[]}>("/appointments?" + query, revision);
  const rows = source.data?.items;
  const [hour, setHour] = useState<number | null>(null);
  const counts = new Map<string, number>();
  const byHour = Array<number>(24).fill(0);
  for (const row of rows ?? []) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    byHour[Number(localTime(row.start_at).slice(0, 2))]++;
  }
  const usedHours = byHour.flatMap((count, index) => count ? [index] : []);
  const start = Math.min(8, ...usedHours);
  const end = Math.max(18, ...usedHours);
  const hours = byHour.map((count, index) => ({count, index})).slice(start, end + 1);
  const maximum = Math.max(1, ...byHour);
  const shown = rows?.filter(row => hour === null || Number(localTime(row.start_at).slice(0,2)) === hour);
  function schedule(status = "", id = "") {
    const params = new URLSearchParams({date: day, view:"appointments", layout:"list"});
    if (area.clinicId) params.set("clinic", area.clinicId);
    if (status) params.set("status", status);
    area.open((id ? "/schedule/appointments/" + id : "/schedule") + "?" + params);
  }
  const count = (state: string) => rows ? (state ? counts.get(state) ?? 0 : rows.length) : "—";
  return <>
    {source.fault && <div className="desk-fault" role="alert">{source.fault} 请使用页面上方的刷新按钮重新读取。</div>}
    {source.loading && <span className="sr-only" role="status">正在读取预约…</span>}
    <section className="desk-metrics" aria-label="预约概况">{tiles.map(tile =>
      <button key={tile.label} className={"desk-metric tone-" + tile.color} onClick={() => schedule(tile.status)}>
        <span className="metric-top"><span>{tile.label}</span><span className="metric-icon"><Icon name={tile.icon} size={19}/></span></span>
        <strong>{count(tile.status)}<small>笔</small></strong><span className="metric-foot">{tile.description}<Icon name="chevron" size={13}/></span>
      </button>)}</section>
    <div className="desk-columns">
      <div className="desk-stack">
        <section className="desk-panel"><div className="desk-panel-head"><div><h2>预约时段分布</h2>
          <p>按预约开始时间统计{rows ? "，共 " + rows.length + " 笔" : ""}</p></div>
          <span className="chart-unit"><i/>预约笔数</span></div>
          <div className="volume-chart" aria-label="分时预约数量">
            <div className="chart-axis" aria-hidden="true"><span>{rows ? maximum : "—"}</span><span>0</span></div>
            <div className="volume-bars">{hours.map(({count: value, index}) =>
              <button key={index} className="volume-hour" aria-label={index + " 时，" + value + " 笔预约"}
                disabled={!rows} aria-pressed={hour === index} onClick={() => setHour(hour === index ? null : index)}>
                <span className="volume-column"><span style={{height: 100 * value / maximum + "%"}}/></span>
                <small>{String(index).padStart(2,"0")}</small></button>)}</div>
          </div>
        </section>
        <section className="desk-panel"><div className="desk-panel-head"><div><h2>预约日程</h2><p>{hour === null ? "按开始时间排列" : hour + ":00 至 " + hour + ":59"} · {day}</p></div>
          <button className="desk-text-action" onClick={() => schedule()}>完整日历 <Icon name="arrow" size={15}/></button></div>
          {hour !== null && <button className="desk-clear" onClick={() => setHour(null)}>清除时段筛选 ×</button>}
          {shown && shown.length ? <div className="agenda-list">{shown.slice(0, 6).map(row =>
            <button key={row.appointment_id} onClick={() => schedule("", row.appointment_id)}>
              <span className="agenda-time">{localTime(row.start_at)}<small>{localTime(row.end_at)}</small></span>
              <span className="agenda-person"><strong>{row.patient_display?.name ?? row.appointment_no}</strong><small>{row.treatment.name} · {row.dentist.name} · {row.clinic.name}</small></span>
              <span className="desk-state" data-state={row.status}>{appointmentStates[row.status] ?? row.status}</span><Icon name="chevron" size={15}/>
            </button>)}</div> : <div className="desk-empty"><span><Icon name="calendar" size={24}/></span>
              <strong>{source.fault ? "预约读取失败" : !rows ? "正在读取日程…" : hour !== null ? "该时段暂无预约" : "当天暂无预约"}</strong>
              {rows && <small>{hour !== null ? "可选择其他时段或清除筛选。" : "可切换日期，查看其他工作日的预约。"}</small>}</div>}
        </section>
      </div>
      <div className="desk-stack">
        <section className="desk-panel"><div className="desk-panel-head"><h2>履约状态</h2><span className="desk-count">{count("")} 笔</span></div>
          <div className="state-strip" aria-hidden="true">{rows?.length ? stateOrder.filter(state => counts.get(state)).map(state =>
            <i key={state} data-state={state} style={{flexGrow:counts.get(state)}}/>) : null}</div>
          <div className="state-legend">{stateOrder.map(state => <button key={state} onClick={() => schedule(state)}>
            <i data-state={state}/><span>{appointmentStates[state]}</span><strong>{count(state)}</strong><Icon name="chevron" size={12}/></button>)}</div>
        </section>
        <WorkLinks {...area}/>
      </div>
    </div>
  </>;
}
type Treatment = {treatment_type_id:string; treatment_name:string; treatment_code:string; active:boolean; current_unit_price:string | null; standard_unit:string};
function Headquarters({area, revision}: {area:WorkArea; revision:number}) {
  const catalog = hasRole(area.identity, ["HQ_CATALOG"], area.clinicId);
  const quarters = hasRole(area.identity, performanceRoles, area.clinicId);
  const treatments = useRead<{items:Treatment[]}>(catalog ? "/catalog/treatments" : undefined, revision);
  const periods = useRead<{items:Period[]}>(quarters ? "/performance/periods" : undefined, revision);
  return <div className="desk-columns hq-columns"><div className="desk-stack">
    {catalog && <section className="desk-panel"><div className="desk-panel-head"><div><h2>项目目录概况</h2><p>总部项目标准与生效价格</p></div>
      <button className="desk-text-action" onClick={() => area.open("/catalog")}>查看目录 <Icon name="arrow" size={15}/></button></div>
      {treatments.fault && <p role="alert" className="error-text">{treatments.fault}</p>}
      {treatments.loading && <p role="status">正在读取项目…</p>}
      {treatments.data && <><div className="hq-metrics">{[["全部项目",treatments.data.items.length],["已启用",treatments.data.items.filter(t => t.active).length],
        ["已启用待定价",treatments.data.items.filter(t => t.active && t.current_unit_price == null).length]].map(([label,value]) =>
        <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
        <div className="hq-records">{treatments.data.items.slice(0,6).map(t => <button key={t.treatment_type_id}
          onClick={() => area.open("/catalog?q=" + encodeURIComponent(t.treatment_code))}><div><strong>{t.treatment_name}</strong><small>{t.treatment_code} · {t.standard_unit}</small></div>
          <span>{t.current_unit_price == null ? "暂无生效价格" : "¥" + t.current_unit_price}</span><Icon name="chevron" size={15}/></button>)}</div></>}
    </section>}
    {quarters && <section className="desk-panel"><div className="desk-panel-head"><div><h2>季度核算进度</h2><p>公司核算期间与最新确认版本</p></div>
      <button className="desk-text-action" onClick={() => area.open("/operations/quarters")}>全部季度 <Icon name="arrow" size={15}/></button></div>
      {periods.fault && <p role="alert" className="error-text">{periods.fault}</p>}
      {periods.loading && <p role="status">正在读取核算期间…</p>}
      {periods.data && (periods.data.items.length ? <div className="hq-records">{[...periods.data.items].sort((a,b)=>b.year-a.year || b.quarter-a.quarter).slice(0,6).map(p =>
        <button key={p.period_id} onClick={() => area.open("/operations/quarters/" + p.period_id)}><div><strong>{p.year} 年第 {p.quarter} 季度</strong>
          <small>{p.latest_confirmed_revision_no ? "最新确认版本 " + p.latest_confirmed_revision_no : "尚无确认版本"}</small></div><span>{p.status && versionStates[p.status]}</span>
          <Icon name="chevron" size={15}/></button>)}</div> : <p className="desk-empty">当前暂无核算期间。</p>)}
    </section>}
    {!catalog && !quarters && <section className="desk-panel"><h2>工作范围</h2><p>当前门店尚未分配可办理的业务。</p></section>}
  </div><WorkLinks {...area}/></div>;
}
export function DashboardPage(area: WorkArea) {
  const today = localDay();
  const [day, setDay] = useState(() => {
    const query = new URLSearchParams(window.location.search).get("date") ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(query) && Number.isFinite(Date.parse(query + "T12:00:00+08:00")) ? query : today;
  });
  const [revision, refresh] = useState(0);
  const daily = hasRole(area.identity, dailyRoles, area.clinicId);
  const scope = area.identity.clinics.find(item => item.clinic_id === area.clinicId)?.name ?? "全部授权门店";
  function chooseDate(next: string) {
    if (!next) return;
    setDay(next);
    const url = new URL(window.location.href); url.searchParams.set("date", next);
    window.history.replaceState({}, "", url);
  }
  return <div className="desk">
    <div className="desk-heading"><div><div className="desk-date"><span/>{dateFormatter.format(new Date((daily ? day : today) + "T12:00:00+08:00"))}</div>
      <h1>{daily ? "门诊工作台" : "总部工作台"}</h1><p>{scope} · {daily ? "预约与诊疗概况" : "岗位业务概况"}</p></div>
      <div className="desk-controls">{daily && <label><span className="sr-only">工作日期</span><input type="date" value={day} onChange={event => chooseDate(event.target.value)}/></label>}
        <button className="button desk-refresh" onClick={() => refresh(value => value + 1)}><Icon name="refresh" size={16}/>刷新</button></div>
    </div>
    {daily ? <DaySchedule key={day} area={area} day={day} revision={revision}/> : <Headquarters area={area} revision={revision}/>}
  </div>;
}
