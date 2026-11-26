import { useState } from "react";
import type { FormEvent } from "react";

import { ActionFeedback } from "../../shared/ActionFeedback";
import type { WorkArea } from "../../shared/AppShell";
import { useAction } from "../../shared/useAction";
import { hasAccessAdministration, homeLabel, jobLabel, jobLabels, roleNames, type JobCode, type StaffProfile } from "../../shared/navigation";
import { dateTime } from "../../shared/format";
import { useRead } from "../../shared/useRead";
import "../catalog/catalog.css";
import "../schedule/schedule.css";

const statuses = new Map([["ACTIVE", "启用"], ["INACTIVE", "停用"], ["ON_LEAVE", "休假"]]);

type ClinicChoice = { clinic_id: string; clinic_no: string; name: string; status: string };
type Clinic = ClinicChoice & { address: string; phone: string | null; email: string | null };
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

function statusLabel(status: string | null) {
  if (status === null) return "未配置";
  return statuses.get(status) ?? status;
}

function ClinicDirectory() {
  const [revision, setRevision] = useState(0);
  const { data, loading, fault } = useRead<{ items: Clinic[] }>("/admin/clinics", revision);
  return <section className="catalog-panel">
    <div className="catalog-toolbar">
      <h1>门店资料</h1>
      <button className="button" type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}>
        重新查询
      </button>
    </div>
    {loading && <p role="status">正在查询门店。</p>}
    {fault && <p className="error-text" role="alert">{fault}</p>}
    {!loading && !fault && data && (data.items.length ? <div className="catalog-scroll">
      <table className="catalog-table">
        <thead><tr>
          <th scope="col">门店编号</th><th scope="col">门店名称</th><th scope="col">地址</th><th scope="col">电话</th>
          <th scope="col">邮箱</th><th scope="col">状态</th>
        </tr></thead>
        <tbody>{data.items.map(clinic => <tr key={clinic.clinic_id}>
          <td>{clinic.clinic_no}</td><th scope="row">{clinic.name}</th><td>{clinic.address}</td>
          <td>{clinic.phone || "—"}</td><td>{clinic.email || "—"}</td><td>{statusLabel(clinic.status)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p>暂无门店资料。</p>)}
  </section>;
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
  const [job, setJob] = useState<JobCode | "">(employee.job_code ?? "");
  const [home, setHome] = useState(employee.home_clinic?.clinic_id ?? "");
  const [profileReason, setProfileReason] = useState("");
  const homeClinicId = job === "HEADQUARTERS" ? null : home || null;
  const profileChanged = job !== employee.job_code || homeClinicId !== (employee.home_clinic?.clinic_id ?? null);
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
    <h2 id="employee-access-heading">{employee.full_name} · {employee.employee_no}</h2>
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
          {directory.clinics.map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>{clinic.name}</option>)}
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
            {clinic.name}（{clinic.clinic_no}）
          </option>)}
        </select></label>
        <label>功能权限<select required value={roleCode} disabled={disabled} onChange={event => setRoleCode(event.target.value)}>
          <option value="">选择功能权限</option>
          {directory.roles.map(role => <option key={role.role_code} value={role.role_code}>{role.role_name}</option>)}
        </select></label>
        <label>授权变更原因<input required maxLength={500} value={grantReason} disabled={disabled}
          onChange={event => setGrantReason(event.target.value)} /></label>
        <button className="button primary" disabled={disabled || !clinicId || !roleCode || !grantReason.trim()}>
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
      </form> : <p className="muted">
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
  const [notice, setNotice] = useState("");
  const [showActionFault, setShowActionFault] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const { data, loading, fault } = useRead<AccessDirectory>("/admin/access", revision);
  const action = useAction();
  const waiting = action.busy || action.unknown;
  const directory = !loading && !fault ? data : undefined;
  const employee = directory?.employees.find(row => row.employee_id === employeeId);
  const history = useRead<{items: AccessEvent[]}>(employee ? "/admin/access/employees/" + employee.employee_id + "/history" : undefined, revision);
  const search = query.trim().toLowerCase();
  const visible = directory?.employees.filter(row =>
    (row.full_name.toLowerCase().includes(search) || row.employee_no.toLowerCase().includes(search))
    && (!jobFilter || (row.job_code ?? "UNSET") === jobFilter)
    && (!grantFilter || (row.permissions ?? row.grants).some(grant => grant.role_code === grantFilter))
    && (!accountFilter || (row.account_status ?? "UNCONFIGURED") === accountFilter),
  );

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

  return <div className="catalog-page">
    <section className="catalog-panel" aria-labelledby="employee-directory-heading">
      <div className="catalog-toolbar">
        <h1 id="employee-directory-heading">员工与权限</h1>
        <button className="button" type="button" disabled={loading || waiting} onClick={() => {
          setNotice("");
          reload();
        }}>重新查询</button>
      </div>
      {fault && <p className="error-text" role="alert">{fault}</p>}
      {loading && <p role="status">正在查询员工权限。</p>}
      {notice && <p role="status">{notice}</p>}
      <ActionFeedback fault={showActionFault ? action.fault : ""} unknown={action.unknown}
        retry={action.retry} busy={action.busy} />
      {visible && <>
        <dl className="staff-summary">
          <div><dt>员工</dt><dd>{directory?.employees.length}</dd></div>
          <div><dt>启用账号</dt><dd>{directory?.employees.filter(row=>row.account_status==="ACTIVE").length}</dd></div>
          <div><dt>门店授权</dt><dd>{directory?.employees.reduce((sum,row)=>sum+row.grants.length,0)}</dd></div>
        </dl>
        <div className="catalog-form">
          <label>查找员工<input type="search" placeholder="姓名或工号" value={query}
            onChange={event => setQuery(event.target.value)} /></label>
          <label>所属岗位筛选<select value={jobFilter} onChange={event => setJobFilter(event.target.value)}>
            <option value="">全部岗位</option><option value="UNSET">待补录</option>
            {Object.entries(jobLabels).map(([code,label]) => <option key={code} value={code}>{label}</option>)}
          </select></label>
          <label>功能权限筛选<select value={grantFilter} onChange={event=>setGrantFilter(event.target.value)}>
            <option value="">全部功能权限</option>
            {Object.entries(roleNames).map(([code,label]) => <option key={code} value={code}>{label}</option>)}
          </select></label>
          <label>账号状态<select value={accountFilter} onChange={event=>setAccountFilter(event.target.value)}>
            <option value="">全部状态</option><option value="ACTIVE">启用</option><option value="INACTIVE">停用</option>
            <option value="UNCONFIGURED">未配置</option>
          </select></label>
        </div>
        {visible.length ? <div className="catalog-scroll">
          <table className="catalog-table">
            <thead><tr>
              <th scope="col">工号</th><th scope="col">姓名</th><th scope="col">所属岗位</th><th scope="col">所属机构</th>
              <th scope="col">员工状态</th><th scope="col">账号状态</th>
            </tr></thead>
            <tbody>{visible.map(row => <tr key={row.employee_id}>
              <td>{row.employee_no}</td>
              <th scope="row"><button className="catalog-link" type="button" disabled={waiting}
                aria-pressed={employeeId === row.employee_id} onClick={() => {
                  setEmployeeId(row.employee_id);
                  setNotice("");
                }}>{row.full_name}</button></th>
              <td>{jobLabel(row.job_code)}</td><td>{homeLabel(row)}</td>
              <td>{statusLabel(row.employee_status)}</td><td>{statusLabel(row.account_status)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p>没有符合条件的员工。</p>}
      </>}
    </section>
    {directory && employee && <>
      <EmployeeEditor key={employee.employee_id} employee={employee}
        directory={directory} disabled={waiting || needsReload} change={change} />
      <section className="catalog-panel">
        <h2>权限变更记录</h2>
        {history.loading && <p role="status">正在读取权限记录…</p>}
        {history.fault && <p className="error-text" role="alert">{history.fault}</p>}
        {history.data && <><p className="muted">{employee.full_name} · 最近 50 条岗位、授权或登录状态变更</p>
          <ul className="compact-list">{history.data.items.map(event => <li key={event.audit_id}>
            <strong>{event.action==="EMPLOYEE_SCOPE_CHANGED"
              ? (event.after.granted ? "授予" : "撤销") + " · " +
                (directory.roles.find(role=>role.role_code===event.after.role_code)?.role_name ?? event.after.role_code)
              : event.action === "EMPLOYEE_PROFILE_CHANGED" ? "岗位资料 · " + jobLabel(event.before.job_code) + " → " + jobLabel(event.after.job_code)
              : statusLabel(event.before.status ?? null) + " → " + statusLabel(event.after.status ?? null)}</strong>
            {event.after.clinic_id && <span>{directory.clinics.find(clinic=>clinic.clinic_id===event.after.clinic_id)?.name ?? event.after.clinic_id}</span>}
            {event.after.home_clinic_id && <span>{directory.clinics.find(clinic => clinic.clinic_id === event.after.home_clinic_id)?.name}</span>}
            <span>{event.after.reason}</span><small>{dateTime(event.occurred_at)} · 操作账号 {event.actor_account_id ?? "—"}</small>
          </li>)}</ul>
          {!history.data.items.length && <p>暂无权限变更。</p>}
        </>}
      </section>
    </>}
  </div>;
}

export function AccessPage({ path, identity }: WorkArea) {
  if (!hasAccessAdministration(identity)) {
    return <section className="catalog-panel"><h1>当前页面无权访问</h1></section>;
  }
  return path === "/admin/clinics" ? <ClinicDirectory /> : <EmployeeAccess />;
}
