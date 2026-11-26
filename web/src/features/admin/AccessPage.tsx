import { useState } from "react";
import type { FormEvent } from "react";

import { ActionFeedback } from "../../shared/ActionFeedback";
import type { WorkArea } from "../../shared/AppShell";
import { useAction } from "../../shared/useAction";
import { hasAccessAdministration, hasResourceAdministration, homeLabel, jobLabel, jobLabels, roleNames, type JobCode, type StaffProfile } from "../../shared/navigation";
import { dateTime } from "../../shared/format";
import { useRead } from "../../shared/useRead";
import "../schedule/schedule.css";
import {
  ChoiceOptions, DirectoryDialog, DirectoryFilter, DirectoryPanel, DirectorySearch, DirectoryTable,
  fields, matches, Status, statusLabel, type ClinicChoice,
} from "./DirectoryUI";
import { ChairDirectory, ClinicDirectory, DentistDirectory, MaterialDirectory, QualificationDirectory } from "./ResourceDirectories";

type Grant = { role_code: string; clinic_id: string };
type Employee = StaffProfile & {
  employee_id: string;
  employee_no: string;
  full_name: string;
  employee_status: string;
  account_status: string | null;
  can_manage_account: boolean;
  can_manage_grants: boolean;
  can_manage_profile: boolean;
  grants: Grant[];
  permissions: { role_code: string; clinic_id: string | null; managed_by_deployment: boolean }[];
};
type AccessDirectory = {
  clinics: ClinicChoice[];
  roles: { role_code: string; role_name: string }[];
  employees: Employee[];
};

type AccessEvent = {
  audit_id: string; action: string; occurred_at: string; actor_account_id: string | null;
  before: {status?: string; job_code?: JobCode | null; home_clinic_id?: string | null};
  after: AccessEvent["before"] & {role_code?: string; clinic_id?: string; granted?: boolean; reason?: string};
};

const jobs = Object.entries(jobLabels).map(([value, label]) => ({ value, label }));
const permissionOptions = Object.entries(roleNames).map(([value, label]) => ({ value, label }));
const accountOptions = [
  { value: "ACTIVE", label: "启用" }, { value: "INACTIVE", label: "停用" }, { value: "UNCONFIGURED", label: "未配置" },
];

function AccountFields() {
  return <>
    <label>登录名<input name="login_identity" maxLength={180} autoComplete="off" required /></label>
    <label>初始密码<input name="password" type="password" minLength={12} maxLength={512} autoComplete="new-password" required />
      <small>至少 12 位，避免常见密码和纯数字。</small>
    </label>
  </>;
}

function accountFields(form: FormData) {
  return { login_identity: fields(form, "login_identity"), password: String(form.get("password") ?? "") };
}

function EmployeeCreate({ directory, disabled, save }: {
  directory: AccessDirectory; disabled: boolean; save: (body: unknown) => void;
}) {
  const [job, setJob] = useState<JobCode | "">("");
  const [withAccount, setWithAccount] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save({
      employee_no: fields(form, "employee_no"), full_name: fields(form, "full_name"), job_code: job,
      home_clinic_id: job === "HEADQUARTERS" ? null : fields(form, "home_clinic_id"),
      ...(withAccount ? { account: accountFields(form) } : {}),
    });
  }
  return <form className="admin-form" onSubmit={submit}>
    <fieldset className="admin-fields" disabled={disabled}>
      <label>工号<input name="employee_no" maxLength={40} required /></label>
      <label>姓名<input name="full_name" maxLength={100} required /></label>
      <label>所属岗位<select required value={job} onChange={event => setJob(event.target.value as JobCode | "")}>
        <option value="">选择岗位</option><ChoiceOptions choices={jobs} />
      </select></label>
      {job && job !== "HEADQUARTERS" && <label>所属门店<select name="home_clinic_id" required defaultValue="">
        <option value="">选择门店</option>
        <ChoiceOptions choices={directory.clinics.filter(clinic => clinic.status === "ACTIVE")
          .map(clinic => ({ value: clinic.clinic_id, label: clinic.name }))} />
      </select></label>}
      <label className="admin-full-field admin-check">
        <input type="checkbox" checked={withAccount} onChange={event => setWithAccount(event.target.checked)} />同时配置登录账号
      </label>
      {withAccount && <AccountFields />}
    </fieldset>
    <div className="admin-controls"><button className="button primary" disabled={disabled}>保存员工</button></div>
  </form>;
}

function EmployeeEditor({ employee, directory, disabled, change }: {
  employee: Employee;
  directory: AccessDirectory;
  disabled: boolean;
  change: (path: string, body: unknown, message: string) => void;
}) {
  const [clinicId, setClinicId] = useState("");
  const [roleCode, setRoleCode] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [accountReason, setAccountReason] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [job, setJob] = useState<JobCode | "">(employee.job_code ?? "");
  const [home, setHome] = useState(employee.home_clinic?.clinic_id ?? "");
  const [profileReason, setProfileReason] = useState("");
  const homeClinicId = job === "HEADQUARTERS" ? null : home || null;
  const profileChanged = job !== employee.job_code || homeClinicId !== (employee.home_clinic?.clinic_id ?? null);
  const activeGrantClinic = directory.clinics.some(clinic => clinic.clinic_id === clinicId && clinic.status === "ACTIVE");
  const granted = employee.grants.some(grant => grant.clinic_id === clinicId && grant.role_code === roleCode);
  const inactive = employee.account_status === "INACTIVE";

  function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    change("profile", {
      job_code: job, home_clinic_id: homeClinicId,
      expected_job_code: employee.job_code ?? null, expected_home_clinic_id: employee.home_clinic?.clinic_id ?? null,
      reason: profileReason.trim(),
    }, "岗位与所属门店已更新。");
  }

  function updateGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    change("grants", {
      clinic_id: clinicId, role_code: roleCode, expected_granted: granted, granted: !granted,
      reason: grantReason.trim(),
    }, "门店授权已更新。");
  }

  function updateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    change("account-status", {
      expected_status: employee.account_status, status: inactive ? "ACTIVE" : "INACTIVE",
      reason: accountReason.trim(),
    }, inactive ? "账号已启用。" : "账号已停用。");
  }

  return <section className="catalog-panel" aria-labelledby="employee-access-heading">
    <h2 id="employee-access-heading">员工档案</h2>
    <dl className="inline-facts" aria-label="员工档案">
      <div><dt>所属岗位</dt><dd>{jobLabel(employee.job_code)}</dd></div>
      <div><dt>所属机构</dt><dd>{homeLabel(employee)}</dd></div>
      <div><dt>员工状态</dt><dd>{statusLabel(employee.employee_status)}</dd></div>
      <div><dt>账号状态</dt><dd>{statusLabel(employee.account_status)}</dd></div>
    </dl>
    {employee.can_manage_profile && <div className="appointment-action">
      <button className="button" type="button" aria-expanded={editingProfile}
        onClick={() => setEditingProfile(!editingProfile)}>{editingProfile ? "收起岗位资料" : "编辑岗位与所属门店"}</button>
      {editingProfile && <form className="catalog-form" onSubmit={updateProfile}>
        <label>所属岗位<select required disabled={disabled} value={job} onChange={event => setJob(event.target.value as JobCode | "")}>
          <option value="">选择岗位</option>
          {Object.entries(jobLabels).map(([code,label]) => <option key={code} value={code}>{label}</option>)}
        </select></label>
        {job !== "HEADQUARTERS" && <label>所属门店<select required disabled={disabled} value={home} onChange={event => setHome(event.target.value)}>
          <option value="">选择门店</option>
          {directory.clinics.filter(clinic => clinic.status === "ACTIVE" || clinic.clinic_id === employee.home_clinic?.clinic_id)
            .map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>{clinic.name}</option>)}
        </select></label>}
        <label>岗位资料变更原因<input required maxLength={500} value={profileReason} disabled={disabled}
          onChange={event => setProfileReason(event.target.value)} /></label>
        <button className="button primary" disabled={disabled || !job || (job !== "HEADQUARTERS" && !home) || !profileChanged || !profileReason.trim()}>
          保存岗位资料
        </button>
      </form>}
    </div>}
    <div className="appointment-action">
      <h3>功能权限与授权范围</h3>
      {(employee.permissions ?? employee.grants).length ? <ul className="compact-list">
        {(employee.permissions ?? employee.grants).map(grant => <li key={grant.role_code + ":" + grant.clinic_id}>
          <strong>{directory.roles.find(role => role.role_code === grant.role_code)?.role_name ?? roleNames[grant.role_code] ?? grant.role_code}</strong>
          <span>{grant.clinic_id ? directory.clinics.find(clinic => clinic.clinic_id === grant.clinic_id)?.name ?? grant.clinic_id
            : grant.role_code === "HQ_ACCESS_ADMIN" ? "全局管理" : "全部门店"}</span>
          {"managed_by_deployment" in grant && grant.managed_by_deployment === true && <small>部署维护</small>}
        </li>)}
      </ul> : <p className="muted">尚未授予功能权限。</p>}
      {employee.can_manage_grants && <form className="catalog-form" onSubmit={updateGrant}>
        <label>授权门店<select required value={clinicId} disabled={disabled} onChange={event => setClinicId(event.target.value)}>
          <option value="">选择门店</option>
          {directory.clinics.map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>
            {clinic.name}（{clinic.clinic_no}）{clinic.status === "INACTIVE" ? " · 已停用" : ""}
          </option>)}
        </select></label>
        <label>功能权限<select required value={roleCode} disabled={disabled} onChange={event => setRoleCode(event.target.value)}>
          <option value="">选择功能权限</option>
          {directory.roles.map(role => <option key={role.role_code} value={role.role_code}>{role.role_name}</option>)}
        </select></label>
        <label>授权变更原因<input required maxLength={500} value={grantReason} disabled={disabled}
          onChange={event => setGrantReason(event.target.value)} /></label>
        <button className="button primary" disabled={disabled || !clinicId || !roleCode || (!granted && !activeGrantClinic) || !grantReason.trim()}>
          {granted ? "撤销权限" : "授予权限"}
        </button>
      </form>}
    </div>
    <div className="appointment-action">
      <h3>登录账号</h3>
      {employee.can_manage_account ? <form className="catalog-form" onSubmit={updateAccount}>
        <label>账号变更原因<input required maxLength={500} value={accountReason} disabled={disabled}
          onChange={event => setAccountReason(event.target.value)} /></label>
        <button className="button" disabled={disabled || !accountReason.trim()}>
          {inactive ? "启用账号" : "停用账号"}
        </button>
      </form> : employee.account_status === null && employee.employee_status === "ACTIVE" && employee.can_manage_profile
        && !employee.permissions?.some(grant => grant.managed_by_deployment) ? <>
        <button className="button" type="button" aria-expanded={creatingAccount} disabled={disabled}
          onClick={() => setCreatingAccount(!creatingAccount)}>配置登录账号</button>
        {creatingAccount && <form className="catalog-form" onSubmit={event => {
          event.preventDefault();
          change("account", accountFields(new FormData(event.currentTarget)), "登录账号已配置。");
        }}>
          <AccountFields />
          <button className="button primary" disabled={disabled}>保存登录账号</button>
        </form>}
      </> : <p className="muted">
        {employee.account_status === null ? "该员工尚未配置账号。" : "该账号由部署维护。"}
      </p>}
    </div>
  </section>;
}

function EmployeeAccess() {
  const [revision, setRevision] = useState(0);
  const [employeeId, setEmployeeId] = useState("");
  const [query, setQuery] = useState("");
  const [jobFilter, setJobFilter] = useState("");
  const [grantFilter, setGrantFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [clinicFilter, setClinicFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [showActionFault, setShowActionFault] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const { data, loading, fault } = useRead<AccessDirectory>("/admin/access", revision);
  const action = useAction();
  const waiting = action.busy || action.unknown;
  const directory = !loading && !fault ? data : undefined;
  const employee = directory?.employees.find(row => row.employee_id === employeeId);
  const history = useRead<{items: AccessEvent[]}>(employee ? "/admin/access/employees/" + employee.employee_id + "/history" : undefined, revision);
  const visible = directory?.employees.filter(row =>
    matches(query, row.full_name, row.employee_no)
    && (!jobFilter || (row.job_code ?? "UNSET") === jobFilter)
    && (!grantFilter || (row.permissions ?? row.grants).some(grant => grant.role_code === grantFilter))
    && (!accountFilter || (row.account_status ?? "UNCONFIGURED") === accountFilter)
    && (!clinicFilter || (row.home_clinic?.clinic_id ?? (row.job_code === "HEADQUARTERS" ? "HQ" : "UNSET")) === clinicFilter),
  ) ?? [];

  function reload() {
    setShowActionFault(false);
    setNeedsReload(false);
    setRevision(value => value + 1);
  }

  function change(path: string, body: unknown, message: string) {
    if (!employee || waiting || needsReload) return;
    action.execute("/admin/access/employees/" + employee.employee_id + "/" + path, body, () => {
      setNotice(message);
      reload();
    }, undefined, {
      onStart: () => { setNotice(""); setShowActionFault(true); },
      onRejection: () => setNeedsReload(true),
    });
  }

  function create(body: unknown) {
    if (waiting) return;
    action.execute<{ employee_id: string }>("/admin/access/employees", body, result => {
      setAdding(false);
      setEmployeeId(result.employee_id);
      setNotice("员工已保存。");
      reload();
    }, undefined, { onStart: () => setShowActionFault(true) });
  }

  function dismiss() {
    setEmployeeId("");
    setAdding(false);
    setShowActionFault(false);
    if (needsReload) reload();
  }

  function historyLabel(event: AccessEvent) {
    if (event.action === "EMPLOYEE_CREATED") return "新增员工";
    if (event.action === "EMPLOYEE_ACCOUNT_CREATED") return "配置登录账号";
    if (event.action === "EMPLOYEE_SCOPE_CHANGED") {
      const role = directory?.roles.find(row => row.role_code === event.after.role_code);
      return (event.after.granted ? "授予" : "撤销") + " · " + (role?.role_name ?? event.after.role_code);
    }
    if (event.action === "EMPLOYEE_PROFILE_CHANGED") {
      return "岗位资料 · " + jobLabel(event.before.job_code) + " → " + jobLabel(event.after.job_code);
    }
    return statusLabel(event.before.status ?? null) + " → " + statusLabel(event.after.status ?? null);
  }

  const showDirectoryNotice = !employeeId && !adding;
  const feedback = <ActionFeedback fault={showActionFault ? action.fault : ""} unknown={action.unknown}
    retry={action.retry} busy={action.busy} />;
  const reloadButton = <button className="button" type="button" disabled={loading || waiting} onClick={() => {
    setNotice("");
    reload();
  }}>重新查询</button>;
  return <div className="catalog-page">
    <DirectoryPanel title="员工与权限" loading={loading} fault={employeeId ? "" : fault} notice={showDirectoryNotice ? notice : undefined}
      controls={<>
        {!employeeId && reloadButton}
        <button className="button primary" type="button" aria-haspopup="dialog" disabled={!directory || waiting} onClick={() => {
          setNotice("");
          setShowActionFault(false);
          setAdding(true);
        }}>新增员工</button>
      </>}
      filters={<>
        <DirectorySearch label="查找员工" placeholder="姓名或工号" value={query} onChange={setQuery} />
        <DirectoryFilter label="所属岗位筛选" all="全部岗位" choices={[{ value: "UNSET", label: "待补录" }, ...jobs]}
          value={jobFilter} onChange={setJobFilter} />
        <DirectoryFilter label="所属机构筛选" all="全部机构" choices={[
          { value: "HQ", label: "总部" }, { value: "UNSET", label: "待补录" },
          ...(directory?.clinics.map(clinic => ({ value: clinic.clinic_id, label: clinic.name })) ?? []),
        ]} value={clinicFilter} onChange={setClinicFilter} />
        <DirectoryFilter label="功能权限筛选" all="全部功能权限" choices={permissionOptions} value={grantFilter} onChange={setGrantFilter} />
        <DirectoryFilter label="账号状态" all="全部状态" choices={accountOptions} value={accountFilter} onChange={setAccountFilter} />
      </>}>
      {directory && <>
        <dl className="staff-summary">
          <div><dt>员工</dt><dd>{directory.employees.length}</dd></div>
          <div><dt>启用账号</dt><dd>{directory.employees.filter(row => row.account_status === "ACTIVE").length}</dd></div>
          <div><dt>门店授权</dt><dd>{directory.employees.reduce((sum, row) => sum + row.grants.length, 0)}</dd></div>
        </dl>
        <DirectoryTable rows={visible} identify={row => row.employee_id} empty="没有符合条件的员工。"
          columns={[
            { label: "工号", cell: row => row.employee_no },
            { label: "姓名", rowHeader: true, cell: row => <button className="catalog-link" type="button" disabled={waiting}
              aria-haspopup="dialog" onClick={() => { setEmployeeId(row.employee_id); setNotice(""); }}>{row.full_name}</button> },
            { label: "所属岗位", cell: row => jobLabel(row.job_code) }, { label: "所属机构", cell: row => homeLabel(row) },
            { label: "员工状态", cell: row => <Status value={row.employee_status} /> },
            { label: "账号状态", cell: row => <Status value={row.account_status} /> },
          ]} />
      </>}
    </DirectoryPanel>
    {adding && directory && <DirectoryDialog title="新增员工" onClose={dismiss} disabled={waiting}>
      <EmployeeCreate directory={directory} disabled={waiting} save={create} />
      {feedback}
    </DirectoryDialog>}
    {employeeId && <DirectoryDialog title={employee ? employee.full_name + " · " + employee.employee_no : "员工详情"}
      onClose={dismiss} disabled={waiting} wide>
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {feedback}
      {needsReload && <div className="admin-controls">{reloadButton}</div>}
      {loading && <p role="status">正在查询员工权限。</p>}
      {fault && <><p className="error-text" role="alert">{fault}</p>{reloadButton}</>}
      {!loading && !fault && !employee && <p className="muted">找不到该员工。</p>}
      {directory && employee && <>
      <EmployeeEditor key={employee.employee_id} employee={employee}
        directory={directory} disabled={waiting || needsReload} change={change} />
      <section className="catalog-panel">
        <h2>权限变更记录</h2>
        {history.loading && <p role="status">正在读取权限记录…</p>}
        {history.fault && <p className="error-text" role="alert">{history.fault}</p>}
        {history.data && <><p className="muted">{employee.full_name} · 最近 50 条档案、授权或账号变更</p>
          <ul className="compact-list">{history.data.items.map(event => <li key={event.audit_id}>
            <strong>{historyLabel(event)}</strong>
            {event.after.clinic_id && <span>{directory.clinics.find(clinic=>clinic.clinic_id===event.after.clinic_id)?.name ?? event.after.clinic_id}</span>}
            {event.after.home_clinic_id && <span>{directory.clinics.find(clinic => clinic.clinic_id === event.after.home_clinic_id)?.name}</span>}
            <span>{event.after.reason}</span><small>{dateTime(event.occurred_at)} · 操作账号 {event.actor_account_id ?? "—"}</small>
          </li>)}</ul>
          {!history.data.items.length && <p>暂无权限变更。</p>}
        </>}
      </section>
      </>}
    </DirectoryDialog>}
  </div>;
}

export function AccessPage({ path, identity }: WorkArea) {
  const access = hasAccessAdministration(identity);
  const resources = hasResourceAdministration(identity);
  if (access && (path === "/admin" || path === "/admin/clinics")) return <ClinicDirectory />;
  if (access && path === "/admin/access") return <EmployeeAccess />;
  if (resources) {
    if (path === "/admin/dentists" || path === "/admin") return <DentistDirectory />;
    if (path === "/admin/qualifications") return <QualificationDirectory />;
    if (path === "/admin/chairs") return <ChairDirectory />;
    if (path === "/admin/materials") return <MaterialDirectory />;
  }
  return <section className="catalog-panel"><h1>当前页面无权访问</h1></section>;
}
