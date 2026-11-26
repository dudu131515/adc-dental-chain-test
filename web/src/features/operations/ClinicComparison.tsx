import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { type FormEvent, useEffect, useState } from "react";
import { useApiRequest } from "../../shared/ApiTransport";
import { dateTime, errorMessage, money } from "../../shared/format";
import { canWorkAt, type StaffIdentity } from "../../shared/navigation";

type Range={from:string;to:string};
type PeriodReport={
  as_of:string;
  report_token:string;
  appointments:{denominator:number;attended:number;unprocessed:number;no_show:number;patient_cancelled:number};
  financial:{net_received:string;accrued:string};
};
type Metric="attendance"|"net"|"unprocessed"|"volume";
const metrics:{id:Metric;label:string}[]=[
  {id:"attendance",label:"实际就诊率"},{id:"net",label:"诊疗净实收"},
  {id:"unprocessed",label:"到期未处置"},{id:"volume",label:"正式预约量"},
];
type Row={clinic:StaffIdentity["clinics"][number];before:PeriodReport;current:PeriodReport};
const percentage=new Intl.NumberFormat("zh-CN",{style:"percent",maximumFractionDigits:1});
const oneDecimal=new Intl.NumberFormat("zh-CN",{maximumFractionDigits:1});
const previousDay=(value:string,offset:number)=>new Date(new Date(value+"T00:00:00Z").valueOf()-offset*86400000).toISOString().slice(0,10);
const getValue=(row:PeriodReport,metric:Metric)=>
  metric==="attendance"?row.appointments.denominator?row.appointments.attended/row.appointments.denominator:null
    :metric==="net"?Number(row.financial.net_received)
    :metric==="unprocessed"?row.appointments.unprocessed:row.appointments.denominator;
const format=(value:number|null,metric:Metric)=>value===null?"不适用":metric==="attendance"?percentage.format(value):metric==="net"?money(value.toFixed(2)):value+" 笔";
const diff=(now:number|null,old:number|null,metric:Metric)=>{
  if(now===null||old===null) return "不适用";
  const delta=now-old;
  const signed=delta>0?"+":delta<0?"−":"";
  return signed+(metric==="attendance"?oneDecimal.format(Math.abs(delta)*100)+" 个百分点":format(Math.abs(delta),metric));
};
function query(range:Range,clinic:string){
  return new URLSearchParams({date_from:range.from,date_to:range.to,clinic_ids:clinic});
}

export function ClinicComparison({identity,open,initial}:{
  identity:StaffIdentity;open:(path:string)=>void;
  initial?:{current:Range;before:Range};
}){
  const { workday } = useWorkspaceRuntime();
  const request=useApiRequest();
  const [clinics]=useState(()=>identity.clinics.filter(branch=>canWorkAt(identity,"HQ_OPERATIONS_QUERY",branch.clinic_id)));
  const [selected,setSelected]=useState(()=>clinics.map(branch=>branch.clinic_id));
  const [metric,setMetric]=useState<Metric>("attendance");
  const [ranges,setRanges]=useState(()=>{
    const end=workday;
    return initial??{current:{from:previousDay(end,6),to:end},before:{from:previousDay(end,13),to:previousDay(end,7)}};
  });
  const [rows,setRows]=useState<Row[]>([]);
  const [loading,setLoading]=useState(false);
  const [fault,setFault]=useState("");
  const [criteria,setCriteria]=useState(()=>({ranges,selected}));
  const [detail,setDetail]=useState<string>();
  useEffect(()=>{
    const controller=new AbortController();
    const signal=controller.signal;
    setLoading(true);
    setFault("");
    setRows([]);
    setDetail(undefined);
    Promise.all(clinics.filter(branch=>criteria.selected.includes(branch.clinic_id)).map(async clinic=>{
      const [before,current]=await Promise.all([
        request<PeriodReport>("/reports/operations?"+query(criteria.ranges.before,clinic.clinic_id),{signal}),
        request<PeriodReport>("/reports/operations?"+query(criteria.ranges.current,clinic.clinic_id),{signal}),
      ]);
      return {clinic,before,current};
    })).then(result=>{if(!signal.aborted)setRows(result);})
      .catch(error=>{if(!signal.aborted)setFault(errorMessage(error));})
      .finally(()=>{if(!signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[criteria,clinics,request]);
  function compare(event:FormEvent){
    event.preventDefault();
    if(!selected.length){ setFault("请至少选择一家门店。");return; }
    if(ranges.current.from>ranges.current.to||ranges.before.from>ranges.before.to){
      setFault("请核对两个期间的起止日期。");return;
    }
    setCriteria({ranges,selected});
  }
  const shown=rows.find(row=>row.clinic.clinic_id===detail);
  const maximum=Math.max(1,...rows.flatMap(row=>
    [row.before,row.current].map(report=>Math.abs(getValue(report,metric)??0))));
  return <div className="operations-sections adc-comparison">
    <section className="schedule-panel">
      <div className="schedule-heading"><div><h2>跨门店经营对比</h2><p className="muted">对照同口径的两个期间和已授权门店。</p></div></div>
      <form className="schedule-form" onSubmit={compare}>
        {(["current","before"] as const).flatMap(side=>(["from","to"] as const).map(field=>
          <label key={side+field}>{(side==="current"?"本期":"对比期")+(field==="from"?"开始":"结束")}
            <input type="date" required value={ranges[side][field]} onChange={event=>{
              const value=event.target.value;
              setRanges(old=>({...old,[side]:{...old[side],[field]:value}}));
            }}/></label>))}
        <fieldset className="adc-compare-branches"><legend>参与比较的门店</legend>
          {clinics.map(branch=><label key={branch.clinic_id}><input type="checkbox"
            checked={selected.includes(branch.clinic_id)} onChange={event=>setSelected(old=>event.target.checked
              ?[...old,branch.clinic_id]:old.filter(id=>id!==branch.clinic_id))}/>{branch.name}</label>)}
        </fieldset>
        <button className="button primary" disabled={loading||!clinics.length}>应用对比</button>
      </form>
      {fault&&<p className="error-text" role="alert">{fault}</p>}
    </section>
    <section className="schedule-panel" aria-label="门店对比结果">
      <div className="schedule-heading"><div><h2>两期门店指标</h2><p className="muted">
        {criteria.ranges.before.from} 至 {criteria.ranges.before.to} → {criteria.ranges.current.from} 至 {criteria.ranges.current.to}</p></div>
        <label>对比指标 <select value={metric} onChange={event=>setMetric(event.target.value as Metric)}>
          {metrics.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
      {loading&&<p role="status">正在读取两期经营数据…</p>}
      {!loading&&!!rows.length&&<div className="adc-comparison-grid">{rows.map(row=>{
        const before=getValue(row.before,metric),current=getValue(row.current,metric);
        return <article key={row.clinic.clinic_id} className="adc-comparison-store">
          <h3>{row.clinic.name}</h3>
          {[{label:"对比期",value:before},{label:"本期",value:current}].map(({label,value})=><div className="adc-compare-bar" key={label}>
            <span>{label}</span><div aria-hidden="true"><i style={{width:Math.abs(value??0)*100/maximum+"%"}}/></div>
            <strong>{format(value,metric)}</strong></div>)}
          <footer><strong>{diff(current,before,metric)}</strong><button className="button"
            aria-expanded={detail===row.clinic.clinic_id} onClick={()=>setDetail(detail===row.clinic.clinic_id?undefined:row.clinic.clinic_id)}>
            {detail===row.clinic.clinic_id?"收起口径":"查看口径与报表"}</button></footer>
        </article>;
      })}</div>}
      {!clinics.length&&<p>当前账号没有可比较的授权门店。</p>}
    </section>
    {shown&&<section className="schedule-panel">
      <h2>{shown.clinic.name} · 指标口径</h2>
      <div className="schedule-scroll"><table className="report-table">
        <thead><tr>{["统计期间","接诊 / 正式预约","到期未处置","已核实爽约","应计收入","净实收","统计截止","报表"].map(label=><th key={label}>{label}</th>)}</tr></thead>
        <tbody>{([{report:shown.before,range:criteria.ranges.before,label:"对比期"},{report:shown.current,range:criteria.ranges.current,label:"本期"}]).map(({report,range,label})=><tr key={label}>
          <th scope="row">{label}</th><td>{report.appointments.attended} / {report.appointments.denominator}</td>
          <td>{report.appointments.unprocessed}</td><td>{report.appointments.no_show}</td>
          <td>{money(report.financial.accrued)}</td><td>{money(report.financial.net_received)}</td><td>{dateTime(report.as_of)}</td>
          <td><button className="text-action" onClick={()=>open("/operations/report?"+query(range,shown.clinic.clinic_id))}>打开{label}报表</button></td></tr>)}</tbody>
      </table></div>
    </section>}
  </div>;
}
