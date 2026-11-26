import { useState } from "react";
import { Icon } from "../src/shared/Icons";
import { type Clinic, clinics, comparison, dailyFacts, money, offices, period, sumFacts } from "./fixtures";

const options = [
  {key:"attendance", label:"对比两店实际就诊率"},
  {key:"unresolved", label:"查看到期未处置预约"},
  {key:"net", label:"诊疗净实收如何变化"},
] as const;
type Metric = (typeof options)[number]["key"];

function rate(fact:{arrived:number;total:number}) { return fact.total ? Math.round((fact.arrived/fact.total)*100) : 0; }
function signed(amount:number) { return amount > 0 ? "+" + amount : amount < 0 ? "−" + Math.abs(amount) : "0"; }

export function OperationsDemo() {
  const [metric,setMetric] = useState<Metric>("attendance");
  const [result,setResult] = useState<Metric>();
  const [source,setSource] = useState(false);
  return <>
    <section className="pd-panel pd-assistant" aria-labelledby="assistant-title">
      <div className="pd-panel-title"><div><span className="pd-assistant-mark"><Icon name="chart" size={17}/>报表解读</span>
        <h2 id="assistant-title">经营分析助手</h2><p>选一个问题，按两期合成报表查看结果。</p></div></div>
      <div className="pd-questions" aria-label="分析建议">{options.map(option => <button key={option.key} type="button"
        aria-pressed={metric === option.key} onClick={() => {setMetric(option.key);setResult(undefined);setSource(false);}}>
        {option.label}</button>)}</div>
      <div className="pd-analysis-footer"><span>{period.previous} 对比 {period.current}</span>
        <button className="button primary" type="button" onClick={() => {setResult(metric);setSource(false);}}>查看分析<Icon name="arrow" size={17}/></button></div>
    </section>
    {result && <section className="pd-panel" aria-live="polite">
      <div className="pd-panel-title"><div><h2>{options.find(option => option.key === result)?.label}</h2><p>{period.previous} → {period.current}</p></div>
        <button className="pd-link" type="button" aria-expanded={source} onClick={() => setSource(value => !value)}>
          {source ? "收起原报表" : "查看原报表"}<Icon name="chevron" size={16}/></button></div>
      <div className="pd-comparisons">{offices.map(office => {
        const {previous,current} = comparison[office];
        const old = result === "attendance" ? rate(previous) + "%" : result === "net" ? money(previous.net) : previous.unresolved + " 笔";
        const fresh = result === "attendance" ? rate(current) + "%" : result === "net" ? money(current.net) : current.unresolved + " 笔";
        const delta = result === "attendance" ? rate(current) - rate(previous)
          : result === "net" ? current.net - previous.net : current.unresolved - previous.unresolved;
        const unit = result === "attendance" ? " 个百分点" : result === "net" ? " 元" : " 笔";
        return <article className="pd-comparison" key={office}>
          <h3>{clinics[office]}</h3><div className="pd-comparison-values"><span>{old}</span><Icon name="arrow" size={18}/><strong>{fresh}</strong></div>
          <span className={"pd-delta " + (delta < 0 ? "down" : "up")}>{signed(delta) + unit}</span>
        </article>;
      })}</div>
    </section>}
    {source && <SourceTable title="两期样例统计"/>}
  </>;
}

export function SourceTable({title}:{title:string}) {
  return <section className="pd-panel" aria-label={title}>
    <div className="pd-panel-title"><div><h2>{title}</h2><p>两期均以已到时段的正式预约为分母</p></div>
      {title==="两店样例指标" && <a href="#operations/ai" className="pd-link">用 AI 分析查看变化<Icon name="arrow" size={16}/></a>}</div>
    <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th scope="col">门店</th><th scope="col">统计期间</th>
      <th scope="col">实际就诊 / 正式预约</th><th scope="col">就诊率</th><th scope="col">到期未处置</th><th scope="col">诊疗净实收</th></tr></thead>
      <tbody>{offices.flatMap(office => (["previous","current"] as const).map(key => {
        const fact = comparison[office][key];
        return <tr key={office+key}><th scope="row">{clinics[office]}</th><td>{period[key]}</td><td>{fact.arrived} / {fact.total}</td>
          <td>{fact.total ? rate(fact)+"%" : "不适用"}</td><td>{fact.unresolved}</td><td>{money(fact.net)}</td></tr>;
      }))}</tbody></table></div>
  </section>;
}

const trendMetrics = [
  {id:"total", label:"正式预约"}, {id:"arrived", label:"实际就诊"}, {id:"net", label:"诊疗净实收"},
] as const;
type TrendMetric=(typeof trendMetrics)[number]["id"];

export function OperationsOverview({clinic}:{clinic:Clinic|"all"}) {
  const [metric,setMetric]=useState<TrendMetric>("total");
  const [window,setWindow]=useState<"current"|"previous">("current");
  const stores=offices.filter(office=>clinic==="all"||clinic===office);
  const allDays=[...new Set(dailyFacts.map(row=>row.day))];
  const selectedDays=window==="current"?allDays.slice(3):allDays.slice(0,3);
  const rows=dailyFacts.filter(row=>stores.includes(row.clinic)&&selectedDays.includes(row.day));
  const totals=sumFacts(rows);
  const max=Math.max(1,...rows.map(row=>row[metric]));
  const kpis=[
    {label:"正式预约",value:totals.total+" 笔"},
    {label:"实际就诊率",value:totals.total?rate(totals)+"%":"不适用"},
    {label:"到期未处置",value:totals.unresolved+" 笔"},
    {label:"诊疗净实收",value:money(totals.net)},
  ];
  return <>
    <div className="pd-metrics pd-compact-metrics">{kpis.map(item=>
      <article className="pd-metric" key={item.label}><div><span>{item.label}</span><strong>{item.value}</strong></div></article>)}</div>
    <div className="pd-report-grid">
      <section className="pd-panel" aria-label="日常经营趋势">
        <div className="pd-panel-title"><div><h2>日常经营趋势</h2><p>{period[window]} · {stores.map(office=>clinics[office]).join("、")}</p></div>
          <label className="pd-search">统计期间<select value={window} onChange={event=>setWindow(event.target.value as "current"|"previous")}>
            <option value="current">本期</option><option value="previous">对比期</option></select></label></div>
        <div className="pd-segments" aria-label="趋势指标">{trendMetrics.map(option=>
          <button aria-pressed={metric===option.id} onClick={()=>setMetric(option.id)} key={option.id}>{option.label}</button>)}</div>
        <div className="pd-trend-graph">{selectedDays.map(day=><div className="pd-trend-day" key={day}>
          <div className="pd-trend-pair">{rows.filter(row=>row.day===day).map(row=><div className="pd-trend-bar" data-clinic={row.clinic} key={row.clinic}
            aria-label={clinics[row.clinic]+" "+day+" "+trendMetrics.find(item=>item.id===metric)?.label+" "+row[metric]}>
            <i style={{height:Math.max(2,row[metric]/max*100)+"%"}}><b>{metric==="net"?money(row[metric]):row[metric]}</b></i></div>)}</div>
          <small>{day}</small></div>)}</div>
        <p className="pd-trend-legend">{stores.map(office=><span key={office}><i data-clinic={office}/>{clinics[office]}</span>)}</p>
      </section>
      <section className="pd-panel"><div className="pd-panel-title"><div><h2>门店履约</h2><p>实际就诊 / 正式预约</p></div></div>
        <div className="pd-attendance">{stores.map(office=>{
          const officeTotals=sumFacts(rows.filter(row=>row.clinic===office));
          return <div key={office}><header><strong>{clinics[office]}</strong><span>{officeTotals.arrived} / {officeTotals.total}</span></header>
            <div className="pd-progress"><i style={{width:rate(officeTotals)+"%"}}/></div><small>{rate(officeTotals)}% 实际就诊</small></div>;
        })}</div>
        <a href="#operations/compare" className="pd-link">打开两店原报表<Icon name="arrow" size={16}/></a>
      </section>
    </div>
    <section className="pd-panel"><div className="pd-panel-title"><div><h2>每日明细</h2><p>与图表使用同一组门店汇总</p></div></div>
      <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th>日期</th><th>门店</th><th>正式预约</th><th>实际就诊</th><th>到期未处置</th><th>诊疗净实收</th></tr></thead><tbody>
        {[...rows].sort((a,b)=>a.day.localeCompare(b.day)).map(row=><tr key={row.day+row.clinic}>
          <th scope="row">{row.day}</th><td>{clinics[row.clinic]}</td><td>{row.total}</td><td>{row.arrived}</td><td>{row.unresolved}</td><td>{money(row.net)}</td>
        </tr>)}
      </tbody></table></div>
    </section>
  </>;
}
