import { useEffect, useRef, useState } from "react";
import { Icon } from "../src/shared/Icons";
import { type Appointment, type Status, appointments, clinics, invoices, money, statusLabels } from "./fixtures";

export function StatusBadge({status}: {status:Status}) {
  return <span className="pd-status" data-status={status}><i aria-hidden="true"/>{statusLabels[status]}</span>;
}

export function AppointmentList({rows, onOpen, patients = false}: {
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


type Pane = "summary" | "history" | "allergies" | "bill";

export function VisitDrawer({visit, initialBill, dismiss}: {visit: Appointment; initialBill:boolean; dismiss: () => void}) {
  const [pane,setPane]=useState<Pane>(initialBill?"bill":"summary");
  const ref = useRef<HTMLDialogElement>(null);
  const related=appointments.filter(row=>row.patient===visit.patient).sort((a,b)=>b.date.localeCompare(a.date));
  const invoiceId=visit.invoice ?? related.find(row=>row.invoice)?.invoice;
  const invoice=invoiceId ? invoices[invoiceId as keyof typeof invoices] : undefined;
  const refundDue=invoice ? Math.max(0, invoice.received-invoice.refunded-invoice.due) : 0;
  const allergen=related.find(row=>row.allergy)?.allergy;
  const tabs:{id:Pane;label:string}[]=[
    {id:"summary",label:"预约概要"},{id:"history",label:"就诊记录"},{id:"allergies",label:"过敏核对"},
  ];
  if (invoice) tabs.push({id:"bill",label:"费用单"});
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
      <nav className="pd-segments pd-record-tabs" aria-label="预约详情分栏">{tabs.map(tab=>
        <button key={tab.id} aria-pressed={pane===tab.id} onClick={()=>setPane(tab.id)}>{tab.label}</button>)}</nav>
      {pane==="summary" && <dl className="pd-facts">
        <div><dt>门店</dt><dd>{clinics[visit.clinic]}</dd></div><div><dt>预约时间</dt><dd>{visit.date} {visit.time}</dd></div>
        <div><dt>诊疗项目</dt><dd>{visit.service}</dd></div><div><dt>责任牙医</dt><dd>{visit.doctor}</dd></div>
      </dl>}
      {(pane==="summary" || pane==="allergies") && <section className={"pd-allergy-box" + (allergen ? " has-allergy" : "")}>
        <h3>过敏核对</h3><p>{allergen ? <><span>已知过敏</span><strong>{allergen}</strong></> : "待核实"}</p>
      </section>}
      {pane==="history" && <section className="pd-related">
        <h3>本人预约与就诊</h3>
        {related.map(item=><article key={item.id}><div><strong>{item.service}</strong><small>{item.date} {item.time} · {clinics[item.clinic]}</small></div>
          <StatusBadge status={item.status}/></article>)}
      </section>}
      {pane==="bill" && invoice && <section className="pd-invoice"><h3>诊疗费用单</h3><p>{invoiceId} · {invoice.status}</p>
        <dl className="pd-facts"><div><dt>当前应缴</dt><dd>{money(invoice.due)}</dd></div>
          <div><dt>成功收款</dt><dd>{money(invoice.received)}</dd></div>
          <div><dt>成功退款</dt><dd>{money(invoice.refunded)}</dd></div>
          <div><dt>欠款</dt><dd>{money(invoice.outstanding)}</dd></div>
          {refundDue>0 && <div className="pd-credit"><dt>待退</dt><dd>{money(refundDue)}</dd></div>}</dl>
      </section>}
    </div>
  </dialog>;
}
