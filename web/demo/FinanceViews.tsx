import { useMemo, useState } from "react";
import { ApiTransport, useApiRequest } from "../src/shared/ApiTransport";
import { BillingQueue, emptyFilters } from "../src/features/billing/BillingPage";
import { Icon } from "../src/shared/Icons";
import { type Appointment, type Clinic, approvals, clinics, days, funds, money } from "./fixtures";
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


type Inspect = (row:Appointment, button:HTMLButtonElement | undefined, bill?:boolean) => void;

export function FinanceWorkspace({route,rows,clinic,date,onOpen}: {
  route:Route; rows:Appointment[]; clinic:Clinic|"all"; date:(typeof days)[number]; onOpen:Inspect;
}) {
  const [filters,setFilters]=useState(emptyFilters);
  const original = useApiRequest();
  const request = useMemo<typeof original>(() => (path, details) => {
    if (!path.startsWith("/billing/queue")) return original(path,details);
    const [route,search] = path.split("?");
    const query = new URLSearchParams(search);
    query.set("date",date);
    return original(route+"?"+query,details);
  }, [original,date]);
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
  return <ApiTransport.Provider value={request}>
    <BillingQueue clinicId={clinic==="all"?"":clinic} invoicesOnly={route!=="billing/queue"} filters={filters}
      update={setFilters} open={path => {
        const id=path.split("/").at(-1);
        const bill=path.startsWith("/billing/invoices/");
        const row=rows.find(item=>bill?item.invoice===id:item.id===id);
        const active=document.activeElement;
        if (row) onOpen(row,active instanceof HTMLButtonElement?active:undefined,bill);
      }}/>
  </ApiTransport.Provider>;
}
