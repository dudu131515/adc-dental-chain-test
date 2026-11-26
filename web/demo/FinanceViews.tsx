import { useState } from "react";
import { Icon } from "../src/shared/Icons";
import { AppointmentList } from "./AppointmentDetails";
import { type Appointment, type Clinic, accessRows, approvals, catalog, clinics, days, funds, invoices, money } from "./fixtures";
import type { Route } from "./workspace";

export function Billing({date, clinic}: {date:(typeof days)[number]; clinic:Clinic | "all"}) {
  const [filter,setFilter]=useState("all");
  const rows = funds.filter(fund => fund.date === date && (clinic === "all" || clinic === fund.clinic));
  function show(kind:"received" | "refund" | "pending", type?: "deposit" | "treatment") {
    return rows.filter(row => row.kind === kind && (!type || row.type === type)).reduce((sum,row) => sum+row.value,0);
  }
  const shown=rows.filter(row=>filter==="all" || (filter==="pending" ? row.kind==="pending" : row.kind!=="pending"));
  return <section className="pd-panel">
    <div className="pd-panel-title"><div><h2>营业日对账</h2><p>模拟资金按成功回执归集</p></div></div>
    <div className="pd-table-wrap"><table className="pd-table"><thead><tr>
      <th scope="col">资金分类</th><th scope="col">成功实收</th><th scope="col">成功退回</th><th scope="col">净额</th>
    </tr></thead><tbody>{(["deposit","treatment"] as const).map(type => <tr key={type}>
      <th scope="row">{type === "deposit" ? "预约金" : "诊疗款"}</th><td>{money(show("received",type))}</td>
      <td>{money(show("refund",type))}</td><td>{money(show("received",type)-show("refund",type))}</td>
    </tr>)}</tbody></table></div>
    <div className="pd-panel-title pd-ledger-title"><div><h2>资金流水</h2><p>当前在途 {money(show("pending"))}</p></div>
      <label className="pd-search">流水状态<select value={filter} onChange={event=>setFilter(event.target.value)}>
        <option value="all">全部流水</option><option value="settled">成功回执</option><option value="pending">处理中</option>
      </select></label></div>
    {shown.length ? <div className="pd-table-wrap"><table className="pd-table"><thead><tr>
      <th scope="col">时间</th><th scope="col">原单据</th><th scope="col">门店</th><th scope="col">类型</th><th scope="col">金额</th>
    </tr></thead><tbody>{shown.map(row => <tr key={row.id+row.label}>
      <td>{row.time}</td><th scope="row">{row.id}</th><td>{clinics[row.clinic]}</td><td>{row.label}</td><td>{money(row.value)}</td>
    </tr>)}</tbody></table></div> : <p className="pd-empty">{rows.length ? "当前流水筛选没有记录。" : "所选门店和日期没有模拟资金记录。"}</p>}
  </section>;
}


type Inspect = (row:Appointment, button:HTMLButtonElement, bill?:boolean) => void;

export function FinanceWorkspace({route,rows,clinic,onOpen}: {
  route:Route; rows:Appointment[]; clinic:Clinic|"all"; onOpen:Inspect;
}) {
  const [state,setState]=useState("all");
  if (route==="billing/approvals") {
    const records=approvals.filter(item => (clinic==="all" || item.clinic===clinic) && rows.some(row=>row.id===item.appointment));
    return <section className="pd-panel"><div className="pd-panel-title"><div><h2>诊疗更正记录</h2><p>查看原预约与审批结果</p></div></div>
      <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th>更正号</th><th>门店</th><th>原因</th><th>差额</th><th>状态</th><th>原预约</th></tr></thead>
        <tbody>{records.map(item=>{
          const row=rows.find(itemRow=>itemRow.id===item.appointment);
          return <tr key={item.id}><th scope="row">{item.id}</th><td>{clinics[item.clinic]}</td><td>{item.reason}</td>
            <td>{money(item.amount)}</td><td>{item.status}</td><td>{row ? <button className="pd-link" onClick={event=>onOpen(row,event.currentTarget)}>{item.appointment}</button>:item.appointment}</td></tr>;
        })}</tbody></table></div>{!records.length && <p className="pd-empty">所选门店暂无更正记录。</p>}</section>;
  }
  const closed=rows.filter(row=>row.status==="done");
  const issued=closed.filter(row=>row.invoice);
  if (route==="billing/queue") {
    const queue=closed.filter(row=>state==="all" || (state==="issued" ? Boolean(row.invoice) : !row.invoice));
    return <section className="pd-panel"><div className="pd-panel-title"><div><h2>已结束就诊</h2>
      <p>{closed.length-issued.length} 笔待开单 · {issued.length} 笔已开单</p></div>
      <label className="pd-search">开单状态<select value={state} onChange={event=>setState(event.target.value)}>
        <option value="all">全部</option><option value="pending">待开单</option><option value="issued">已开单</option>
      </select></label></div><AppointmentList rows={queue} onOpen={onOpen}/></section>;
  }
  const bills=issued.flatMap(row => {
    const id=row.invoice as keyof typeof invoices;
    return id && invoices[id] ? [{row,id,invoice:invoices[id]}]:[];
  }).filter(item=>state==="all" || (state==="due" ? item.invoice.outstanding > 0 : item.invoice.outstanding===0));
  return <section className="pd-panel"><div className="pd-panel-title"><div><h2>诊疗费用单</h2><p>查看原主单、实际收退和欠款</p></div>
    <label className="pd-search">收款状态<select value={state} onChange={event=>setState(event.target.value)}>
      <option value="all">全部</option><option value="due">有欠款</option><option value="settled">已结清</option>
    </select></label></div>
    {bills.length ? <div className="pd-table-wrap"><table className="pd-table"><thead><tr>
      <th>主单编号</th><th>患者</th><th>当前应缴</th><th>成功收款</th><th>成功退款</th><th>欠款</th><th>详情</th>
    </tr></thead><tbody>{bills.map(({id,row,invoice})=><tr key={id}><th scope="row">{id}</th>
      <td>{row.patient}</td><td>{money(invoice.due)}</td><td>{money(invoice.received)}</td><td>{money(invoice.refunded)}</td>
      <td>{money(invoice.outstanding)}</td><td><button className="pd-link" aria-label={"查看 "+id}
        onClick={event=>onOpen(row,event.currentTarget,true)}>查看<Icon name="chevron" size={14}/></button></td></tr>)}</tbody>
    </table></div>:<p className="pd-empty">当前筛选下没有诊疗费用单。</p>}</section>;
}

export function BusinessDirectory({route}:{route:Route}) {
  const [lookup,setLookup]=useState("");
  if(route==="operations/catalog") return <section className="pd-panel">
    <div className="pd-panel-title"><div><h2>项目标准与生效价</h2></div>
      <label className="pd-search">项目搜索<input value={lookup} onChange={event=>setLookup(event.target.value)} placeholder="名称或编码"/></label></div>
    <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th>项目编号</th><th>项目</th><th>基准价格</th><th>预估用时</th><th>生效日期</th></tr></thead>
      <tbody>{catalog.filter(item=>(item.code+item.name).toLowerCase().includes(lookup.trim().toLowerCase())).map(item=>
        <tr key={item.code}><th scope="row">{item.code}</th><td>{item.name}</td><td>{money(item.price)}</td><td>{item.duration} 分钟</td><td>{item.date}</td></tr>)}</tbody></table></div></section>;
  if(route==="operations/access") return <section className="pd-panel">
    <div className="pd-panel-title"><div><h2>门店角色与业务范围</h2></div></div>
    <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th>职责</th><th>门店范围</th><th>业务入口</th></tr></thead><tbody>
      {accessRows.map(item=><tr key={item.role}><th scope="row">{item.role}</th><td>{item.scope}</td><td>{item.actions}</td></tr>)}
    </tbody></table></div></section>;
  return <section className="pd-panel"><div className="pd-panel-title"><div><h2>核算周期</h2><p>核对费用、试算、复核与确认进度</p></div></div>
    <div className="pd-table-wrap"><table className="pd-table"><thead><tr><th>季度</th><th>门店范围</th><th>费用登记</th><th>核算版本</th><th>当前状态</th></tr></thead><tbody>
      <tr><th scope="row">2026 年第三季度</th><td>两家门店</td><td>已核对</td><td>确认版 V1</td><td>已确认</td></tr>
      <tr><th scope="row">2026 年第四季度</th><td>两家门店</td><td>待本季度结束</td><td>—</td><td>未确认</td></tr>
    </tbody></table></div></section>;
}
