import { FormEvent, useEffect, useRef, useState } from "react";

import { request } from "../../shared/api";
import { PriceVersions } from "./PriceVersions";
import "./catalog.css";

type Treatment = {
  treatment_type_id: string;
  treatment_code: string;
  treatment_name: string;
  standard_unit: string;
  required_qualification_id: string | null;
  default_slot_minutes: number | null;
  required_chair_kind: string | null;
  active: boolean;
  current_unit_price: string | null;
};
type Qualification = { qualification_id: string; name: string };

function StandardForm({ treatment, qualifications, onSave }: {
  treatment?: Treatment;
  qualifications: Qualification[];
  onSave: (item: Treatment) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const prefix = "/catalog/treatments";
      const result = await request<Treatment>(treatment ? prefix + "/" + treatment.treatment_type_id : prefix, {
        method: treatment ? "PATCH" : "POST", actionKey: crypto.randomUUID(),
        body: {
          treatment_code: data.get("code"), treatment_name: data.get("name"), standard_unit: data.get("unit"),
          required_qualification_id: data.get("qualification") || null,
          default_slot_minutes: data.get("minutes") ? Number(data.get("minutes")) : null,
          required_chair_kind: data.get("chair_kind") || null, active: data.get("active") === "on",
        },
      });
      onSave(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存项目。");
    } finally {
      setPending(false);
    }
  }

  return <form className="catalog-form" onSubmit={save}>
    <label>编码<input name="code" maxLength={50} defaultValue={treatment?.treatment_code} required /></label>
    <label>名称<input name="name" maxLength={160} defaultValue={treatment?.treatment_name} required /></label>
    <label>计量单位<input name="unit" maxLength={50} defaultValue={treatment?.standard_unit} required /></label>
    <label>资格<select name="qualification" defaultValue={treatment?.required_qualification_id || ""}>
      <option value="">不限资格</option>
      {qualifications.map(item => <option value={item.qualification_id} key={item.qualification_id}>{item.name}</option>)}
    </select></label>
    <label>预计占时（分钟）<input name="minutes" type="number" min={1} defaultValue={treatment?.default_slot_minutes || ""} placeholder="留空由牙医估时" /></label>
    <label>适配椅型<input name="chair_kind" maxLength={40} defaultValue={treatment?.required_chair_kind || ""} /></label>
    <label className="catalog-check"><input name="active" type="checkbox" defaultChecked={treatment?.active ?? true} />启用</label>
    <button className="button primary" disabled={pending}>保存项目</button>
    {error && <p className="error-text" role="alert">{error}</p>}
  </form>;
}

export function CatalogPage({canEdit = true}: {canEdit?: boolean}) {
  const [rows, setRows] = useState<Treatment[]>([]);
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [selected, setSelected] = useState<Treatment>();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState(() => new URLSearchParams(window.location.search).get("q") || "");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    Promise.all([
      request<{ items: Treatment[] }>("/catalog/treatments", { signal: abort.signal }),
      request<{ items: Qualification[] }>("/qualifications", { signal: abort.signal }),
    ]).then(([treatments, source]) => {
      setRows(treatments.items);
      setQualifications(source.items);
    }).catch(failure => {
      if (!abort.signal.aborted) setError(failure.message);
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [revision]);

  function search(query: string) {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
    setFilter(query);
  }

  function save(item: Treatment) {
    setAdding(false);
    setSelected(item);
    setRevision(old => old + 1);
  }

  function close() {
    setSelected(undefined);
    setAdding(false);
    trigger.current?.focus();
  }

  const term = filter.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => row.treatment_name.toLocaleLowerCase().includes(term) || row.treatment_code.toLocaleLowerCase().includes(term));
  return <div className="catalog-page">
    <h1>项目与价格</h1>
    <section className="catalog-panel">
      <div className="catalog-toolbar">
        <label>搜索项目 <input value={filter} onChange={event => search(event.target.value)} placeholder="项目名称或编码" /></label>
        {canEdit && <button className="button primary" onClick={event => {
          trigger.current = event.currentTarget;
          setSelected(undefined);
          setAdding(true);
        }}>新增项目</button>}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="catalog-scroll">
        <table className="catalog-table">
          <thead><tr><th>编码</th><th>项目</th><th>单位</th><th>资格</th><th>预计占时</th><th>椅型</th><th>当前价</th><th>状态</th></tr></thead>
          <tbody>
            {filtered.map(row => <tr key={row.treatment_type_id}>
              <td>{row.treatment_code}</td>
              <td><button className="catalog-link" onClick={event => {
                trigger.current = event.currentTarget;
                setAdding(false);
                setSelected(row);
              }}>{row.treatment_name}</button></td>
              <td>{row.standard_unit}</td>
              <td>{qualifications.find(item => item.qualification_id === row.required_qualification_id)?.name || "不限"}</td>
              <td>{row.default_slot_minutes ? row.default_slot_minutes + " 分钟" : "牙医估时"}</td>
              <td>{row.required_chair_kind || "通用要求"}</td>
              <td>{row.current_unit_price !== null ? "¥" + row.current_unit_price : "暂无生效价格"}</td>
              <td>{row.active ? "已启用" : "已停用"}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {(loading || !filtered.length) && !error && <p className="muted">{loading ? "正在读取项目…" : "没有符合条件的项目。"}</p>}
    </section>
    {(selected || adding) && <aside className="catalog-detail" aria-label="项目详情" onKeyDown={event => {
      if (event.key === "Escape") close();
    }}>
      <header className="catalog-toolbar"><h2>{selected?.treatment_name || "新增项目"}</h2><button autoFocus className="button" onClick={close}>关闭</button></header>
      {canEdit && <StandardForm key={"standard:" + (selected?.treatment_type_id || "new")} treatment={selected} qualifications={qualifications} onSave={save} />}
      {selected && <PriceVersions key={"versions:" + selected.treatment_type_id} treatmentId={selected.treatment_type_id} canEdit={canEdit} onChange={() => setRevision(old => old + 1)} />}
    </aside>}
  </div>;
}
