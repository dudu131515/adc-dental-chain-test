import { useState, type ReactNode } from "react";

import { money } from "../../shared/format";
import { useRead } from "../../shared/useRead";
import { useWorkspaceRuntime } from "../../shared/WorkspaceRuntime";
import { PriceVersions } from "../catalog/PriceVersions";
import {
  activeOptions, ChoiceOptions, DirectoryDialog, DirectoryFilter, DirectoryPanel, DirectorySearch,
  DirectoryTable, fields, matches, ResourceEditor, Status, type ClinicChoice, type Option,
} from "./DirectoryUI";

type Items<Row> = { items: Row[] };
type Filter<Row> = {
  key: string; label: string; all: string; choices: readonly Option[]; value: (row: Row) => string;
};

function Resources<Row, Data extends Items<Row>>({
  title, singular, route, identify, search, filters, columns, editor, body, canAdd, renderAction, onSave,
}: {
  title: string; singular: string; route: string; identify: (row: Row) => string;
  search: { label: string; placeholder: string; values: (row: Row) => (string | null | undefined)[] };
  filters?: (data: Data | undefined) => Filter<Row>[];
  columns: Parameters<typeof DirectoryTable<Row>>[0]["columns"];
  editor: (row: Row | undefined, data: Data) => ReactNode;
  body: (form: FormData, row?: Row) => Record<string, unknown>;
  canAdd?: (data: Data) => boolean;
  renderAction?: (row: Row, refresh: () => void) => ReactNode;
  onSave?: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<{ row?: Row }>();
  const [notice, setNotice] = useState("");
  const { data, loading, fault } = useRead<Data>(route, revision);
  const choices = filters?.(data) ?? [];
  const visible = data?.items.filter(row => matches(query, ...search.values(row))
    && choices.every(filter => !values[filter.key] || filter.value(row) === values[filter.key])) ?? [];
  const refresh = () => setRevision(value => value + 1);
  function close(needsRefresh: boolean) {
    setDraft(undefined);
    if (needsRefresh) refresh();
  }
  function payload(form: FormData, row?: Row) {
    const full = body(form, row);
    if (!row) return full;
    return Object.fromEntries(Object.entries(full).filter(([field, value]) => row[field as keyof Row] !== value));
  }
  return <div className="catalog-page">
    <DirectoryPanel title={title} loading={loading} fault={fault} notice={notice}
      controls={<>
        <button className="button" type="button" disabled={loading} onClick={() => { setNotice(""); refresh(); }}>重新查询</button>
        <button className="button primary" type="button" aria-haspopup="dialog" disabled={!data || canAdd?.(data) === false}
          onClick={() => { setNotice(""); setDraft({}); }}>新增{singular}</button>
      </>}
      filters={<>
        <DirectorySearch label={search.label} placeholder={search.placeholder} value={query} onChange={setQuery} />
        {choices.map(filter => <DirectoryFilter key={filter.key} label={filter.label} all={filter.all} choices={filter.choices}
          value={values[filter.key] ?? ""} onChange={value => setValues(old => ({ ...old, [filter.key]: value }))} />)}
      </>}>
      <DirectoryTable identify={identify} rows={visible} empty={`没有符合条件的${singular}。`}
        columns={[...columns, { label: "操作", cell: row => <div className="admin-controls">
          <button className="catalog-link" type="button" aria-haspopup="dialog" onClick={() => { setNotice(""); setDraft({ row }); }}>编辑{singular}</button>
          {renderAction?.(row, refresh)}
        </div> }]} />
    </DirectoryPanel>
    {draft && data && <ResourceEditor route={route} id={draft.row && identify(draft.row)}
      title={(draft.row ? "编辑" : "新增") + singular} saveLabel={"保存" + singular} body={form => payload(form, draft.row)}
      onSave={() => { close(true); setNotice(singular + "已保存。"); onSave?.(); }} onClose={close}>
      {editor(draft.row, data)}
    </ResourceEditor>}
  </div>;
}

type Clinic = ClinicChoice & { address: string; phone: string | null; email: string | null };

export function ClinicDirectory() {
  return <Resources<Clinic, Items<Clinic>> title="门店资料" singular="门店" route="/admin/clinics"
    onSave={() => window.dispatchEvent(new Event("adc:clinic-directory-changed"))}
    identify={row => row.clinic_id}
    search={{ label: "查找门店", placeholder: "门店名称、编号或地址", values: row => [row.name, row.clinic_no, row.address] }}
    filters={() => [{ key: "status", label: "状态筛选", all: "全部状态", choices: activeOptions, value: row => row.status }]}
    columns={[
      { label: "门店编号", cell: row => row.clinic_no }, { label: "门店名称", cell: row => row.name, rowHeader: true },
      { label: "地址", cell: row => row.address }, { label: "电话", cell: row => row.phone || "—" },
      { label: "邮箱", cell: row => row.email || "—" }, { label: "状态", cell: row => <Status value={row.status} /> },
    ]}
    body={form => ({
      clinic_no: fields(form, "clinic_no"), name: fields(form, "name"), address: fields(form, "address"),
      phone: fields(form, "phone") || null, email: fields(form, "email") || null, status: fields(form, "status"),
    })}
    editor={row => <>
      <label>门店编号<input name="clinic_no" maxLength={40} required defaultValue={row?.clinic_no} /></label>
      <label>门店名称<input name="name" maxLength={150} required defaultValue={row?.name} /></label>
      <label>地址<input name="address" required defaultValue={row?.address} /></label>
      <label>电话<input name="phone" type="tel" maxLength={40} defaultValue={row?.phone ?? ""} /></label>
      <label>邮箱<input name="email" type="email" maxLength={120} defaultValue={row?.email ?? ""} /></label>
      <label>门店状态<select name="status" defaultValue={row?.status ?? "ACTIVE"}><ChoiceOptions choices={activeOptions} /></select></label>
    </>} />;
}

type Chair = { chair_id: string; clinic_id: string; clinic_name: string; chair_no: string; chair_kind: string; status: string };
const chairStatuses = [{ value: "AVAILABLE", label: "可用" }, { value: "INACTIVE", label: "停用" }];
const clinicOptions = (clinics: ClinicChoice[]) => clinics.map(clinic => ({
  value: clinic.clinic_id, label: `${clinic.name}（${clinic.clinic_no}）`,
}));

export function ChairDirectory() {
  return <Resources<Chair, Items<Chair> & { clinics: ClinicChoice[] }> title="牙椅管理" singular="牙椅" route="/admin/chairs"
    identify={row => row.chair_id}
    search={{ label: "查找牙椅", placeholder: "牙椅编号、类型或门店", values: row => [row.chair_no, row.chair_kind, row.clinic_name] }}
    filters={data => [
      { key: "clinic", label: "门店筛选", all: "全部门店", choices: clinicOptions(data?.clinics ?? []), value: row => row.clinic_id },
      { key: "status", label: "状态筛选", all: "全部状态", choices: chairStatuses, value: row => row.status },
    ]}
    columns={[
      { label: "牙椅编号", cell: row => row.chair_no, rowHeader: true }, { label: "所属门店", cell: row => row.clinic_name },
      { label: "牙椅类型", cell: row => row.chair_kind }, { label: "使用状态", cell: row => <Status value={row.status} /> },
    ]}
    canAdd={data => data.clinics.some(clinic => clinic.status === "ACTIVE")}
    body={form => ({
      clinic_id: fields(form, "clinic_id"), chair_no: fields(form, "chair_no"),
      chair_kind: fields(form, "chair_kind"), status: fields(form, "status"),
    })}
    editor={(row, data) => <>
      <label>所属门店<select name="clinic_id" required defaultValue={row?.clinic_id ?? ""}>
        <option value="">选择门店</option>
        <ChoiceOptions choices={clinicOptions(data.clinics.filter(clinic => clinic.status === "ACTIVE" || clinic.clinic_id === row?.clinic_id))} />
      </select></label>
      <label>牙椅编号<input name="chair_no" maxLength={40} required defaultValue={row?.chair_no} /></label>
      <label>牙椅类型<input name="chair_kind" maxLength={40} required defaultValue={row?.chair_kind ?? "GENERAL"} /></label>
      <label>使用状态<select name="status" defaultValue={row?.status ?? "AVAILABLE"}><ChoiceOptions choices={chairStatuses} /></select></label>
    </>} />;
}

type Qualification = { qualification_id: string; qualification_code: string; qualification_name: string };
type Dentist = { employee_id: string; employee_no: string; full_name: string };
type Credential = {
  credential_id: string; employee_id: string; employee_no: string; employee_name: string;
  qualification_id: string; qualification_code: string; qualification_name: string; certificate_no: string | null;
  valid_from: string | null; valid_until: string | null;
};
type DentistData = Items<Credential> & { dentists: Dentist[]; qualifications: Qualification[] };

export function QualificationDirectory() {
  return <Resources<Qualification, Items<Qualification>> title="资质类型" singular="资质类型" route="/admin/qualifications"
    identify={row => row.qualification_id}
    search={{ label: "查找资质类型", placeholder: "名称或编码", values: row => [row.qualification_name, row.qualification_code] }}
    columns={[
      { label: "资质编码", cell: row => row.qualification_code },
      { label: "资质名称", cell: row => row.qualification_name, rowHeader: true },
    ]}
    body={form => ({ qualification_code: fields(form, "qualification_code"), qualification_name: fields(form, "qualification_name") })}
    editor={row => <>
      <label>资质编码<input name="qualification_code" maxLength={50} required defaultValue={row?.qualification_code} /></label>
      <label>资质名称<input name="qualification_name" maxLength={120} required defaultValue={row?.qualification_name} /></label>
    </>} />;
}

const qualificationOptions = (qualifications: Qualification[]) => qualifications.map(item => ({
  value: item.qualification_id, label: `${item.qualification_name}（${item.qualification_code}）`,
}));
const validity = [
  { value: "valid", label: "有效" }, { value: "future", label: "待生效" }, { value: "expired", label: "已到期" },
];

export function DentistDirectory() {
  const { workday } = useWorkspaceRuntime();
  function validityKey(row: Credential) {
    if (row.valid_until && row.valid_until < workday) return "expired";
    if (row.valid_from && row.valid_from > workday) return "future";
    return "valid";
  }
  return <Resources<Credential, DentistData> title="牙医资质" singular="牙医资质" route="/admin/dentist-qualifications"
    identify={row => row.credential_id}
    search={{ label: "查找牙医资质", placeholder: "姓名、工号、资质或证书编号",
      values: row => [row.employee_name, row.employee_no, row.qualification_name, row.qualification_code, row.certificate_no] }}
    filters={data => [
      { key: "qualification", label: "资质筛选", all: "全部资质", choices: qualificationOptions(data?.qualifications ?? []), value: row => row.qualification_id },
      { key: "validity", label: "有效状态", all: "全部状态", choices: validity, value: validityKey },
    ]}
    columns={[
      { label: "牙医", cell: row => `${row.employee_name}（${row.employee_no}）`, rowHeader: true },
      { label: "资质", cell: row => row.qualification_name }, { label: "证书编号", cell: row => row.certificate_no || "—" },
      { label: "生效日期", cell: row => row.valid_from || "—" }, { label: "有效至", cell: row => row.valid_until || "—" },
      { label: "状态", cell: row => validity.find(item => item.value === validityKey(row))?.label },
    ]}
    canAdd={data => Boolean(data.dentists.length && data.qualifications.length)}
    body={(form, row) => ({
      ...(row ? {} : { employee_id: fields(form, "employee_id"), qualification_id: fields(form, "qualification_id") }),
      certificate_no: fields(form, "certificate_no") || null, valid_from: fields(form, "valid_from") || null,
      valid_until: fields(form, "valid_until") || null,
    })}
    editor={(row, data) => <>
      {row ? <>
        <label>牙医<input readOnly value={`${row.employee_name}（${row.employee_no}）`} /></label>
        <label>资质<input readOnly value={row.qualification_name} /></label>
      </> : <>
        <label>牙医<select name="employee_id" required defaultValue="">
          <option value="">选择牙医</option><ChoiceOptions choices={data.dentists.map(item => ({
            value: item.employee_id, label: `${item.full_name}（${item.employee_no}）`,
          }))} />
        </select></label>
        <label>资质<select name="qualification_id" required defaultValue="">
          <option value="">选择资质</option><ChoiceOptions choices={qualificationOptions(data.qualifications)} />
        </select></label>
      </>}
      <label>证书编号<input name="certificate_no" maxLength={80} defaultValue={row?.certificate_no ?? ""} /></label>
      <label>生效日期<input name="valid_from" type="date" defaultValue={row?.valid_from ?? ""} /></label>
      <label>有效至<input name="valid_until" type="date" defaultValue={row?.valid_until ?? ""} /></label>
    </>} />;
}

type Material = {
  material_id: string; material_code: string; material_name: string; standard_unit: string;
  status: string; current_unit_cost: string | null;
};

export function MaterialDirectory() {
  const [costs, setCosts] = useState<{ row: Material; refresh: () => void }>();
  const [savingCost, setSavingCost] = useState(false);
  return <>
    <Resources<Material, Items<Material>> title="耗材管理" singular="耗材" route="/admin/materials"
      identify={row => row.material_id}
      search={{ label: "查找耗材", placeholder: "耗材名称或编码", values: row => [row.material_name, row.material_code] }}
      filters={() => [{ key: "status", label: "状态筛选", all: "全部状态", choices: activeOptions, value: row => row.status }]}
      columns={[
        { label: "耗材编码", cell: row => row.material_code }, { label: "耗材名称", cell: row => row.material_name, rowHeader: true },
        { label: "计量单位", cell: row => row.standard_unit }, { label: "当前单位成本", cell: row => money(row.current_unit_cost) },
        { label: "状态", cell: row => <Status value={row.status} /> },
      ]}
      body={form => ({
        material_code: fields(form, "material_code"), material_name: fields(form, "material_name"),
        standard_unit: fields(form, "standard_unit"), status: fields(form, "status"),
      })}
      editor={row => <>
        <label>耗材编码<input name="material_code" maxLength={40} required defaultValue={row?.material_code} /></label>
        <label>耗材名称<input name="material_name" maxLength={140} required defaultValue={row?.material_name} /></label>
        <label>计量单位<input name="standard_unit" maxLength={50} required defaultValue={row?.standard_unit} /></label>
        <label>耗材状态<select name="status" defaultValue={row?.status ?? "ACTIVE"}><ChoiceOptions choices={activeOptions} /></select></label>
      </>}
      renderAction={(row, refresh) => <button type="button" className="catalog-link" aria-haspopup="dialog"
        onClick={() => setCosts({ row, refresh })}>成本版本</button>}
    />
    {costs && <DirectoryDialog title={costs.row.material_name} wide onClose={() => setCosts(undefined)} disabled={savingCost}>
      <PriceVersions kind="cost" treatmentId={costs.row.material_id} canEdit onChange={costs.refresh} onPending={setSavingCost} />
    </DirectoryDialog>}
  </>;
}
