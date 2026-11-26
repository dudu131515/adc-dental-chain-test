import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { FormEvent, useEffect, useRef, useState } from "react";

import { useApiRequest } from "../../shared/ApiTransport";
import {
  activeOptions, DirectoryDialog, DirectoryFilter, DirectoryPanel, DirectorySearch, DirectoryTable, matches, resultUnknown, Status,
  validationMessage,
} from "../admin/DirectoryUI";
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

function StandardForm({ treatment, qualifications, onSave, onPending, disabled }: {
  treatment?: Treatment;
  qualifications: Qualification[];
  onSave: (item: Treatment) => void;
  onPending: (pending: boolean) => void;
  disabled: boolean;
}) {
  const request = useApiRequest();
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || disabled || unknown) return;
    active.current = true;
    setPending(true);
    onPending(true);
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
      const unclear = resultUnknown(failure);
      setUnknown(unclear);
      setError(unclear ? "保存结果待核对。关闭后可重新查询项目。" : validationMessage(failure));
    } finally {
      active.current = false;
      setPending(false);
      onPending(false);
    }
  }

  const locked = pending || disabled || unknown;
  return <form className="admin-form" onSubmit={save}>
    <fieldset className="admin-fields" disabled={locked}>
      <label>编码<input name="code" maxLength={50} defaultValue={treatment?.treatment_code} required /></label>
      <label>名称<input name="name" maxLength={160} defaultValue={treatment?.treatment_name} required /></label>
      <label>计量单位<input name="unit" maxLength={50} defaultValue={treatment?.standard_unit} required /></label>
      <label>资格<select name="qualification" defaultValue={treatment?.required_qualification_id || ""}>
        <option value="">不限资格</option>
        {qualifications.map(item => <option value={item.qualification_id} key={item.qualification_id}>{item.name}</option>)}
      </select></label>
      <label>预计占时（分钟）<input name="minutes" type="number" min={1} max={2147483647}
        defaultValue={treatment?.default_slot_minutes || ""} placeholder="留空由牙医估时" /></label>
      <label>适配椅型<input name="chair_kind" maxLength={40} defaultValue={treatment?.required_chair_kind || ""} /></label>
      <label className="admin-check"><input name="active" type="checkbox" defaultChecked={treatment?.active ?? true} />启用</label>
    </fieldset>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="admin-controls"><button className="button primary" disabled={locked}>保存项目</button></div>
  </form>;
}

export function CatalogPage({canEdit = true}: {canEdit?: boolean}) {
  const { router } = useWorkspaceRuntime();
  const request = useApiRequest();
  const [rows, setRows] = useState<Treatment[]>([]);
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [selected, setSelected] = useState<Treatment>();
  const [adding, setAdding] = useState(false);
  const [savingStandard, setSavingStandard] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [filter, setFilter] = useState(() => new URLSearchParams(router.read().search).get("q") || "");
  const [status, setStatus] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
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
  }, [revision, request]);

  function search(query: string) {
    const url = new URL(router.read().url, window.location.origin);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    router.write(url.pathname + url.search);
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
  }

  const filtered = rows.filter(row => matches(filter, row.treatment_name, row.treatment_code)
    && (!status || (row.active ? "ACTIVE" : "INACTIVE") === status));
  return <div className="catalog-page">
    <DirectoryPanel title="项目与价格" loading={loading} fault={error}
      controls={<>
        <button className="button" type="button" disabled={loading} onClick={() => {
          setLoading(true);
          setRevision(old => old + 1);
        }}>重新查询</button>
        {canEdit && <button className="button primary" type="button" aria-haspopup="dialog" disabled={loading || Boolean(error)} onClick={() => {
          setSelected(undefined); setAdding(true);
        }}>新增项目</button>}
      </>}
      filters={<>
        <DirectorySearch label="搜索项目" placeholder="项目名称或编码" value={filter} onChange={search} />
        <DirectoryFilter label="项目状态" value={status} onChange={setStatus} all="全部状态" choices={activeOptions} />
      </>}>
      <DirectoryTable rows={filtered} identify={row => row.treatment_type_id} empty="没有符合条件的项目。"
        columns={[
          { label: "编码", cell: row => row.treatment_code },
          { label: "项目", rowHeader: true, cell: row => <button className="catalog-link" type="button" aria-haspopup="dialog" onClick={() => {
            setAdding(false); setSelected(row);
          }}>{row.treatment_name}</button> },
          { label: "单位", cell: row => row.standard_unit },
          { label: "资格", cell: row => qualifications.find(item => item.qualification_id === row.required_qualification_id)?.name || "不限" },
          { label: "预计占时", cell: row => row.default_slot_minutes ? row.default_slot_minutes + " 分钟" : "牙医估时" },
          { label: "椅型", cell: row => row.required_chair_kind || "通用要求" },
          { label: "当前价", cell: row => row.current_unit_price !== null ? "¥" + row.current_unit_price : "暂无生效价格" },
          { label: "状态", cell: row => <Status value={row.active ? "ACTIVE" : "INACTIVE"} /> },
        ]} />
    </DirectoryPanel>
    {(selected || adding) && <DirectoryDialog title={selected?.treatment_name || "新增项目"} onClose={close} wide
      disabled={savingStandard || savingVersion}>
      {canEdit && <StandardForm key={"standard:" + (selected?.treatment_type_id || "new")} treatment={selected} qualifications={qualifications}
        onSave={save} disabled={savingVersion} onPending={setSavingStandard} />}
      {selected && <PriceVersions key={"versions:" + selected.treatment_type_id} treatmentId={selected.treatment_type_id} canEdit={canEdit}
        onChange={() => setRevision(old => old + 1)} disabled={savingStandard} onPending={setSavingVersion} />}
    </DirectoryDialog>}
  </div>;
}
