import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { FormEvent, useState } from "react";
import { canWorkAt, type WorkArea } from "../../shared/AppShell";
import { dateTime, localDay } from "../../shared/format";
import { useRead } from "../../shared/useRead";
import { RegisterPatient, type Patient } from "../schedule/BookingForm";
import { invoiceStates } from "../billing/billingTypes";
import { visitStates } from "../clinical/clinicalTypes";
import { appointmentStates } from "../schedule/appointmentTypes";
import "./patients.css";

type PageInfo = { page: number; page_size: number; total: number };
type Directory = PageInfo & { items: (Patient & { next_start: string | null })[] };
type History = { appointment_id: string; appointment_no: string; start_at: string; treatment: string; dentist: string; status: string;
  visit?: { visit_id: string; status: string }; invoice?: { invoice_id: string; invoice_no: string; status: string };
};
type Profile = PageInfo & { patient: Patient; appointments: History[] };

function Pager({ result, choose }: { result: PageInfo; choose: (n: number) => void }) {
  const pages = Math.ceil(result.total / result.page_size);
  if (pages < 2) return null;
  return <div className="patient-pager">
    <button className="button" disabled={result.page < 2} onClick={() => choose(result.page - 1)}>上一页</button>
    <span>第 {result.page} / {pages} 页</span>
    <button className="button" disabled={result.page >= pages} onClick={() => choose(result.page + 1)}>下一页</button>
  </div>;
}

function PersonMark({ name }: { name: string }) {
  return <span className="patient-mark" aria-hidden="true">{Array.from(name)[0]}</span>;
}

function PatientRecord({ clinic, id, open, directory }: {
  clinic: string; id: string; open: WorkArea["open"]; directory: () => void;
}) {
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const read = useRead<Profile>("/clinics/" + clinic + "/patients/" + id + "?page=" + page, refresh);
  const patient = read.data?.patient;
  return <section className="patient-page">
    <button className="patient-back" onClick={directory}>‹ 返回患者名册</button>
    {read.loading && <p role="status">正在读取档案…</p>}
    {read.fault && <div role="alert">{read.fault} <button className="button" onClick={() => setRefresh(v => v + 1)}>重试</button></div>}
    {patient && read.data && <>
      <div className="patient-record-head">
        <PersonMark name={patient.full_name} />
        <div><h1>{patient.full_name}</h1><p className="patient-id">患者编号 {patient.patient_no}</p></div>
        <button className="button primary" onClick={() => open("/schedule?" + new URLSearchParams({ clinic, action: "book", patient: id }))}>为此患者预约</button>
      </div>
      <div className="patient-profile-grid">
        <section className="patient-card"><h2>身份与联络</h2>
          <dl className="patient-facts"><div><dt>出生日期</dt><dd>{patient.birth_date}</dd></div>
            <div><dt>联系电话</dt><dd><a href={"tel:" + patient.phone}>{patient.phone}</a></dd></div></dl>
        </section>
        <section className="patient-card"><div className="patient-heading"><h2>本店预约、就诊与费用</h2><span>{read.data.total} 笔</span></div>
          {!read.data.total && <p className="patient-empty">患者已建档，可以从上方为其安排首次预约。</p>}
          <ol className="patient-timeline">{read.data.appointments.map(row => <li key={row.appointment_id}>
            <time dateTime={row.start_at}>{dateTime(row.start_at)}</time>
            <p><strong>{row.treatment}</strong><span className="status-tag" data-state={row.status}>{appointmentStates[row.status] ?? row.status}</span></p>
            <span>{row.dentist} · {row.appointment_no}</span>
            <div className="patient-visit-links">
              <button className="patient-link" onClick={() => open("/schedule/appointments/" + row.appointment_id + "?" +
                new URLSearchParams({ clinic, date: localDay(new Date(row.start_at)) }))}>查看预约详情 ›</button>
              {row.visit && <>
                <span>就诊 {row.visit.visit_id} · {visitStates[row.visit.status] ?? row.visit.status}</span>
                {row.invoice ? <button className="patient-link" onClick={() => open("/billing/invoices/" + row.invoice!.invoice_id)}>
                  {invoiceStates[row.invoice.status] ?? row.invoice.status} · {row.invoice.invoice_no} ›
                </button> : row.visit.status !== "IN_PROGRESS" && <button className="patient-link"
                  onClick={() => open("/billing/visits/" + row.visit!.visit_id)}>查看待开单 ›</button>}
              </>}
            </div>
          </li>)}</ol><Pager result={read.data} choose={setPage} />
        </section>
      </div>
    </>}
  </section>;
}

export function PatientsPage({ identity, clinicId, path, open }: WorkArea) {
  const { router } = useWorkspaceRuntime();
  const params = new URLSearchParams(router.read().search);
  const choices = identity.clinics.filter(row => canWorkAt(identity, "FRONT_DESK", row.clinic_id));
  const selected = clinicId || (choices.find(row => row.clinic_id === params.get("clinic")) || choices[0])?.clinic_id || "";
  const [clinic, setClinic] = useState(selected);
  const allowed = choices.some(row => row.clinic_id === clinic);
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState(search);
  const [page, setPage] = useState(1);
  const [register, setRegister] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const id = path.match(/^\/patients\/(\d+)$/)?.[1];
  const query = new URLSearchParams({ q: submitted, page: String(page) });
  const read = useRead<Directory>(allowed && clinic && !id ? "/clinics/" + clinic + "/patient-directory?" + query : undefined, refresh);
  const storeName = choices.find(row => row.clinic_id === clinic)?.name;
  function directory() {
    const args = new URLSearchParams({ clinic });
    open("/patients?" + args);
    setRefresh(v => v + 1);
  }
  function show(record: Patient) {
    setRegister(false);
    open("/patients/" + record.patient_id + "?" + new URLSearchParams({ clinic }));
  }
  function searchDirectory(event: FormEvent) {
    event.preventDefault(); setSubmitted(search.trim()); setPage(1);
    router.write("/patients?" + new URLSearchParams({ clinic }));
  }
  if (!allowed) return <section className="patient-page"><h1>患者档案</h1><p>请选择具备前台权限的门店。</p></section>;
  if (id) return <PatientRecord key={clinic + ":" + id} clinic={clinic} id={id} open={open} directory={directory} />;
  return <section className="patient-page">
    <div className="patient-heading"><div><h1>患者档案</h1><p className="patient-sub">{storeName} · 登记、查找与就诊联络</p></div>
      <button className="button primary" aria-expanded={register} onClick={() => setRegister(v => !v)}>{register ? "收起登记" : "＋ 登记新患者"}</button>
    </div>
    {register && <div className="patient-card patient-registration"><RegisterPatient expanded clinic={clinic} onSaved={show} /></div>}
    <div className="patient-card patient-roster">
      <div className="patient-heading"><h2>患者名册</h2>{read.data && <span>{read.data.total} 位患者</span>}</div>
      <form className="patient-filter" onSubmit={searchDirectory}>
        {!clinicId && choices.length > 1 && <label>门店<select value={clinic} onChange={e => { setClinic(e.target.value); setPage(1); setRegister(false); setSearch(""); setSubmitted(""); }}>{choices.map(row =>
          <option key={row.clinic_id} value={row.clinic_id}>{row.name}</option>)}</select></label>}
        <label><span className="patient-reader">查找患者</span><input type="search" placeholder="输入姓名、完整手机号或患者编号" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <button className="button">查询</button>
        {submitted && <button type="button" className="patient-link" onClick={() => { setSearch(""); setSubmitted(""); setPage(1); router.write("/patients?clinic=" + clinic); }}>清除筛选</button>}
      </form>
      {read.loading && <p role="status">正在读取名册…</p>}
      {read.fault && <div role="alert">{read.fault} <button className="button" onClick={() => setRefresh(v => v + 1)}>重试</button></div>}
      {submitted && (read.data?.items.length ?? 0) > 1 && <p className="muted">找到多份档案，请按患者编号、出生日期和联系方式分别核对。</p>}
      {read.data && (read.data.items.length ? <div className="patient-table-wrap"><table className="patient-table">
        <thead><tr><th>患者</th><th>出生日期</th><th>联系电话</th><th>下次预约</th><th><span className="patient-reader">档案</span></th></tr></thead>
        <tbody>{read.data.items.map(row => <tr key={row.patient_id}><td><button className="patient-person" onClick={() => show(row)}>
          <PersonMark name={row.full_name} /><span><strong>{row.full_name}</strong><small>{row.patient_no}</small></span></button></td>
          <td>{row.birth_date}</td><td>{row.phone}</td><td>{row.next_start ? dateTime(row.next_start) : "暂无预约"}</td>
          <td><button className="patient-link" onClick={() => show(row)}>查看档案 ›</button></td></tr>)}</tbody>
      </table></div> : <p className="patient-empty">{submitted ? "没有匹配的患者，请核对姓名、电话或编号后重新查询。" : "本店尚无患者档案，可从右上角登记首位患者。"}</p>)}
      {read.data && <Pager result={read.data} choose={setPage} />}
    </div>
  </section>;
}
