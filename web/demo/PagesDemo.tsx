import { useMemo, useState } from "react";
import { StaffApp } from "../src/StaffApp";
import { ApiTransport } from "../src/shared/ApiTransport";
import { advanceSession, ApiError, captureScope, type request } from "../src/shared/api";
import { createWorkspaceRouter, WorkspaceRuntime } from "../src/shared/WorkspaceRuntime";
import { createSampleWorkspace, sampleRoles, sampleTime, type SampleRole } from "./sampleWorkspace";
import "./demo-mode.css";

const routes: Record<string, string> = {
  home: "/dashboard", desk: "/schedule/today", "desk/home": "/schedule/today",
  schedule: "/schedule?view=appointments", "desk/calendar": "/schedule?view=appointments",
  "desk/staff": "/schedule?view=shifts", "desk/demands": "/schedule?view=demands", "desk/chairs": "/schedule?view=resources",
  patients: "/patients", "patients/directory": "/patients", "patients/queue": "/clinical", "patients/records": "/clinical/records",
  billing: "/billing", "billing/queue": "/billing", "billing/reconcile": "/billing/reconciliation", "billing/approvals": "/billing/corrections",
  operations: "/operations/report", "operations/overview": "/operations/report", "operations/ai": "/operations/assistant",
  "operations/quarter": "/operations/quarters", "operations/catalog": "/catalog",
  "operations/clinics": "/admin/clinics", "operations/access": "/admin/access",
};
const router = createWorkspaceRouter(() => {
  const hash = window.location.hash.slice(1);
  const [route, search] = hash.split("?", 2);
  if (route.startsWith("/")) return hash;
  const path = routes[route] ?? (route ? "/" + route : "/dashboard");
  return search ? path + (path.includes("?") ? "&" : "?") + search : path;
});
const runtime = { router, sampleTime: Date.parse(sampleTime) };
const storageKey = "adc:demo-identity";
const mainRoles = ["front", "dentist", "manager", "scheduler"] as const;
const otherRoles = (Object.keys(sampleRoles) as SampleRole[]).filter(role =>
  role !== "visitor" && !mainRoles.some(main => main === role));
function initialRole(): SampleRole {
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored && Object.hasOwn(sampleRoles, stored)) return stored as SampleRole;
  } catch {
    // The demo can run with browser storage disabled.
  }
  return "front";
}

export function PagesDemo() {
  const [workspace] = useState(createSampleWorkspace);
  const [role, setRole] = useState<SampleRole | null>(initialRole);
  function switchRole(next: SampleRole | null) {
    advanceSession();
    try {
      if (next) sessionStorage.setItem(storageKey, next);
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Identity can still change in memory.
    }
    setRole(next);
  }
  const transport = useMemo(() => role ? workspace.transport(role) : undefined, [workspace, role]);
  const api = useMemo(() => async <T,>(path: string, details?: Parameters<typeof request>[1]): Promise<T> => {
    details?.signal?.throwIfAborted();
    if (path === "/auth/logout") {
      switchRole(null);
      return undefined as T;
    }
    if (!role || !transport) throw new ApiError(401, {code:"AUTHENTICATION_REQUIRED", message:"请选择样例身份。"});
    if (path === "/auth/me") return workspace.identity(role) as T;
    const scopeActive = captureScope();
    const result = await transport<T>(path, details);
    if (!scopeActive()) throw new ApiError(409, {code:"SESSION_CHANGED", message:"工作范围已变更。"});
    return result;
  }, [workspace, role, transport]);
  const controls = <div className="demo-controls">
    <span className="demo-label">合成数据演示</span>
    <select aria-label="样例身份" value={role ?? ""} onChange={event => switchRole(event.target.value as SampleRole)}>
      <optgroup label="日常体验">{mainRoles.map(key => <option key={key} value={key}>{sampleRoles[key].label}</option>)}</optgroup>
      <optgroup label="其他样例">{otherRoles.map(key => <option key={key} value={key}>{sampleRoles[key].label}</option>)}</optgroup>
    </select>
  </div>;
  const signIn = <><h1>体验诊所工作台</h1><p className="login-summary">选择身份进入合成数据演示。</p>
    <div className="demo-signin">{mainRoles.map(key =>
      <button className="button" type="button" key={key} onClick={() => switchRole(key)}>{sampleRoles[key].label}</button>)}</div></>;
  return <WorkspaceRuntime.Provider value={runtime}>
    <ApiTransport.Provider value={api}>
      <StaffApp key={role ?? "signed-out"} sample={{ controls, signIn }} />
    </ApiTransport.Provider>
  </WorkspaceRuntime.Provider>;
}
