import { useState } from "react";
import type { FormEvent } from "react";

import { ActionFeedback } from "../../shared/ActionFeedback";
import type { WorkArea } from "../../shared/AppShell";
import { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import "../catalog/catalog.css";
import "../schedule/schedule.css";

const statuses = new Map([["ACTIVE", "启用"], ["INACTIVE", "停用"], ["ON_LEAVE", "休假"]]);

type ClinicChoice = { clinic_id: string; clinic_no: string; name: string; status: string };
type Clinic = ClinicChoice & { address: string; phone: string | null; email: string | null };
type Grant = { role_code: string; clinic_id: string };
type Employee = {
  employee_id: string;
  employee_no: string;
  full_name: string;
  employee_status: string;
  account_status: string | null;
  can_manage_account: boolean;
  can_manage_grants: boolean;
  grants: Grant[];
};
type AccessDirectory = {
  clinics: ClinicChoice[];
  roles: { role_code: string; role_name: string }[];
  employees: Employee[];
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
  const granted = employee.grants.some(grant => grant.clinic_id === clinicId && grant.role_code === roleCode);
  const inactive = employee.account_status === "INACTIVE";

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
    <div className="appointment-action">
      <h3>门店授权</h3>
      {employee.grants.length ? <ul className="compact-list">
        {employee.grants.map(grant => <li key={grant.role_code + ":" + grant.clinic_id}>
          <span>{directory.clinics.find(clinic => clinic.clinic_id === grant.clinic_id)?.name ?? grant.clinic_id}</span>
          <span>{directory.roles.find(role => role.role_code === grant.role_code)?.role_name ?? grant.role_code}</span>
        </li>)}
      </ul> : <p className="muted">暂无门店授权。</p>}
      {employee.can_manage_grants && <form className="catalog-form" onSubmit={updateGrant}>
        <label>授权门店<select required value={clinicId} disabled={disabled} onChange={event => setClinicId(event.target.value)}>
          <option value="">选择门店</option>
          {directory.clinics.map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>
            {clinic.name}（{clinic.clinic_no}）
          </option>)}
        </select></label>
        <label>预设角色<select required value={roleCode} disabled={disabled} onChange={event => setRoleCode(event.target.value)}>
          <option value="">选择角色</option>
          {directory.roles.map(role => <option key={role.role_code} value={role.role_code}>{role.role_name}</option>)}
        </select></label>
        <label>授权变更原因<input required maxLength={500} value={grantReason} disabled={disabled}
          onChange={event => setGrantReason(event.target.value)} /></label>
        <button className="button primary" disabled={disabled || !clinicId || !roleCode || !grantReason.trim()}>
          {granted ? "撤销角色" : "授予角色"}
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
  const [notice, setNotice] = useState("");
  const [showActionFault, setShowActionFault] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const { data, loading, fault } = useRead<AccessDirectory>("/admin/access", revision);
  const action = useAction();
  const waiting = action.busy || action.unknown;
  const directory = !loading && !fault ? data : undefined;
  const employee = directory?.employees.find(row => row.employee_id === employeeId);
  const search = query.trim().toLowerCase();
  const visible = directory?.employees.filter(row =>
    row.full_name.toLowerCase().includes(search) || row.employee_no.toLowerCase().includes(search),
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
        <h1 id="employee-directory-heading">员工权限</h1>
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
        <div className="catalog-form">
          <label>查找员工<input type="search" placeholder="姓名或工号" value={query}
            onChange={event => setQuery(event.target.value)} /></label>
        </div>
        {visible.length ? <div className="catalog-scroll">
          <table className="catalog-table">
            <thead><tr>
              <th scope="col">工号</th><th scope="col">姓名</th><th scope="col">员工状态</th><th scope="col">账号状态</th>
            </tr></thead>
            <tbody>{visible.map(row => <tr key={row.employee_id}>
              <td>{row.employee_no}</td>
              <th scope="row"><button className="catalog-link" type="button" disabled={waiting}
                aria-pressed={employeeId === row.employee_id} onClick={() => {
                  setEmployeeId(row.employee_id);
                  setNotice("");
                }}>{row.full_name}</button></th>
              <td>{statusLabel(row.employee_status)}</td><td>{statusLabel(row.account_status)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p>没有符合条件的员工。</p>}
      </>}
    </section>
    {directory && employee && <EmployeeEditor key={employee.employee_id} employee={employee}
      directory={directory} disabled={waiting || needsReload} change={change} />}
  </div>;
}

export function AccessPage({ path, identity }: WorkArea) {
  if (!identity.capabilities.includes("HQ_ACCESS_ADMIN") || identity.role_clinic_ids?.HQ_ACCESS_ADMIN !== null) {
    return <section className="catalog-panel"><h1>当前页面无权访问</h1></section>;
  }
  return path === "/admin/clinics" ? <ClinicDirectory /> : <EmployeeAccess />;
}
