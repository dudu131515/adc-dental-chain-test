import { useState } from "react";
import { Icon } from "../src/shared/Icons";
import { type Clinic, clinics, comparison, money, period } from "./fixtures";

const options = [
  {key:"attendance", label:"对比两店实际就诊率"},
  {key:"unresolved", label:"查看到期未处置预约"},
  {key:"net", label:"诊疗净实收如何变化"},
] as const;
type Metric = (typeof options)[number]["key"];
const offices = Object.keys(clinics) as Clinic[];

function rate(fact:{arrived:number;total:number}) { return Math.round((fact.arrived/fact.total)*100); }
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
    {source && <section className="pd-panel" aria-label="两期样例统计">
      <div className="pd-panel-title"><div><h2>两期样例统计</h2><p>与上方分析使用同一组汇总数据</p></div></div>
      <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th scope="col">门店</th><th scope="col">统计期间</th>
        <th scope="col">实际就诊 / 正式预约</th><th scope="col">到期未处置</th><th scope="col">诊疗净实收</th></tr></thead>
        <tbody>{offices.flatMap(office => ([ "previous", "current" ] as const).map(key => {
          const fact = comparison[office][key];
          return <tr key={office+key}><th scope="row">{clinics[office]}</th><td>{period[key]}</td><td>{fact.arrived} / {fact.total}</td>
            <td>{fact.unresolved}</td><td>{money(fact.net)}</td></tr>;
        }))}</tbody></table></div>
    </section>}
  </>;
}
