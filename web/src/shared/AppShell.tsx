import { MouseEvent, ReactNode, useEffect, useRef, useState } from "react";
import { LoginPage } from "../features/login/LoginPage";
import { ApiError, request } from "./api";
import { Brand, Icon } from "./Icons";
import { allowedSections, canSeeDailyReconciliation, groupedNavigation, navigation, roleNames, workspaceTabs } from "./navigation";
import type { StaffIdentity } from "./navigation";

export type { StaffIdentity } from "./navigation";
export { canWorkAt } from "./navigation";
export type WorkArea = {
  section: string; path: string; identity: StaffIdentity; clinicId: string; open: (path: string) => void;
};
function isUnder(path: string, area: string) { return path === area || path.startsWith(area + "/"); }
function filterKey(path: string) {
  if (path === "/operations") return "/operations/report";
  return isUnder(path, "/schedule") ? "/schedule" : path;
}
function rememberedClinic(identity: StaffIdentity) {
  if (identity.clinics.length === 1) return identity.clinics[0].clinic_id;
  try {
    const stored = sessionStorage.getItem("adc:work-clinic:" + identity.account_id);
    return identity.clinics.find(clinic => clinic.clinic_id === stored)?.clinic_id ?? "";
  } catch {
    return "";
  }
}
function currentUrl() { return window.location.pathname + window.location.search; }

export function AppShell({ renderWorkArea }: { renderWorkArea?: (area: WorkArea) => ReactNode }) {
  const [identity, setIdentity] = useState<StaffIdentity | null>();
  const [location, setLocation] = useState(currentUrl);
  const [clinicId, setClinicId] = useState("");
  const [fault, setFault] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [menu, setMenu] = useState(false);
  const [disclosures, setDisclosures] = useState<Record<string, boolean>>({});
  const filterHistory = useRef<Record<string, string>>({});
  const menuToggle = useRef<HTMLButtonElement>(null);
  function open(path: string, replace = false) {
    filterHistory.current[filterKey(window.location.pathname)] = window.location.search;
    const previousQuery = filterHistory.current[filterKey(path)];
    if (!path.includes("?") && previousQuery) path += previousQuery;
    if (replace) window.history.replaceState({}, "", path);
    else if (currentUrl() !== path) window.history.pushState({}, "", path);
    setLocation(currentUrl());
    setMenu(false);
  }
  function accept(session: StaffIdentity) {
    if (session.category !== "staff") { setIdentity(null); return; }
    const initialClinic = rememberedClinic(session);
    setIdentity(session);
    setClinicId(initialClinic);
    if (!allowedSections(session, initialClinic).some(area => isUnder(window.location.pathname, area.path))) {
      open("/dashboard", true);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setFault("");
    request<StaffIdentity>("/auth/me", {signal: controller.signal}).then(session => {
      if (!controller.signal.aborted) accept(session);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) setIdentity(null);
      else setFault("暂时无法确认登录状态。");
    });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const sync = () => { setLocation(currentUrl()); setMenu(false); };
    const expired = () => {
      setIdentity(null); setClinicId(""); setMenu(false); setDisclosures({}); setFault(""); filterHistory.current = {};
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("adc:session-expired", expired);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("adc:session-expired", expired); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    function close(event: KeyboardEvent) {
      if (event.key === "Escape") { setMenu(false); menuToggle.current?.focus(); }
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true); setFault("");
    try {
      await request("/auth/logout", {method: "POST"});
      window.dispatchEvent(new Event("adc:session-expired"));
      window.history.replaceState({}, "", "/");
      setLocation(currentUrl());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setIdentity(null);
      else setFault("退出结果待核对，请重试。");
    } finally { setLoggingOut(false); }
  }
  function navigate(event: MouseEvent<HTMLAnchorElement>, path: string) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); open(path);
  }
  const path = location.split("?")[0];
  const choices = identity ? allowedSections(identity, clinicId) : [];
  const canUseRoute = !isUnder(path, "/billing/reconciliation") || (identity && canSeeDailyReconciliation(identity, clinicId));
  const chosen = canUseRoute ? choices.find(area => isUnder(path, area.path)) : undefined;
  const groups = groupedNavigation(choices);
  const activeGroup = groups.find(group => chosen && group.sections.includes(chosen));
  const tabs = identity && activeGroup ? workspaceTabs(activeGroup, identity, clinicId) : [];
  const activeTab = activeGroup?.id === "desk" && path !== "/schedule/today"
    ? tabs.find(tab => tab.path === "/schedule?view=" + (isUnder(path, "/schedule/appointments")
      ? "appointments" : new URLSearchParams(location.split("?")[1]).get("view") || "appointments")) ?? tabs[1]
    : [...tabs].sort((a, b) => b.path.length - a.path.length).find(tab => isUnder(path, tab.path))
      ?? tabs.find(tab => chosen && isUnder(tab.path, chosen.path));
  useEffect(() => {
    const active = activeGroup?.id;
    if (active && active !== "home") setDisclosures(previous => ({...previous, [active]: true}));
  }, [activeGroup?.id, activeTab?.path]);
  useEffect(() => {
    document.title = (identity ? chosen?.label || "员工工作空间" : "员工登录") + " · ADC 安德鲁牙科";
  }, [identity, chosen?.label]);

  if (identity === null) return <LoginPage onLogin={accept} />;
  if (!identity) return <main className="session-check"><Brand /><p role="status">{fault || "正在核对登录状态…"}</p>
    {fault && <button className="button primary" onClick={() => setAttempt(attempt + 1)}>重试</button>}</main>;

  function changeClinic(next: string) {
    setClinicId(next);
    try {
      sessionStorage.setItem("adc:work-clinic:" + identity!.account_id, next);
    } catch {
      // The selector remains usable when the browser blocks storage.
    }
    filterHistory.current = {};
    const root = chosen && allowedSections(identity!, next).includes(chosen) ? chosen.path : "/dashboard";
    const destination = root === "/schedule" && path === "/schedule/today" ? path : root;
    const keptDate = new URLSearchParams(window.location.search).get("date");
    const target = keptDate && (root === "/dashboard" || root === "/schedule")
      ? destination + "?" + new URLSearchParams({date: keptDate}) : destination;
    // Detail pages and their local filters belong to the previous scope.
    window.history.replaceState({}, "", target);
    setLocation(currentUrl());
  }
  const roles = identity.capabilities.map(role => roleNames[role]).filter(Boolean).join(" · ");
  return <div className="app-layout">
    <a className="skip-link" href="#workspace">跳至工作区</a>
    <aside className={"side-rail" + (menu ? " rail-open" : "")}>
      <a href="/dashboard" className="brand-link" aria-label="ADC 安德鲁牙科工作台" onClick={e => navigate(e, "/dashboard")}><Brand /></a>
      <div className="rail-caption">员工工作空间</div>
      <nav id="staff-navigation" className="side-nav" aria-label="业务导航">
        {groups.map(group => {
          const current = activeGroup === group;
          if (group.id === "home") return <a key={group.id} className="rail-nav-item" href="/dashboard"
            onClick={event => navigate(event, "/dashboard")} aria-current={current ? "page" : undefined}>
            <Icon name={group.icon}/><span>首页</span>{current && <span className="active-light" aria-hidden="true"/>}</a>;
          const expanded = disclosures[group.id] ?? current;
          const listId = "staff-nav-" + group.id;
          return <div key={group.id}>
            <button type="button" className="rail-nav-item" data-active={current} aria-expanded={expanded}
              aria-controls={listId} onClick={() => setDisclosures(previous => ({...previous, [group.id]: !expanded}))}>
              <Icon name={group.icon}/><span>{group.label}</span><Icon name="chevron" size={14}/>
            </button>
            <ul id={listId} className="rail-subnav" hidden={!expanded}>
              {workspaceTabs(group, identity, clinicId).map(tab => <li key={tab.path}><a href={tab.path}
                onClick={event => navigate(event, tab.path)} aria-current={current && activeTab?.path === tab.path ? "page" : undefined}>
                {tab.label}</a></li>)}
            </ul>
          </div>;
        })}
      </nav>
      <div className="rail-account"><span className="staff-avatar"><Icon name="user"/></span>
        <div><strong title={roles}>{roles || "员工"}</strong><small>账号 {identity.account_id}</small></div></div>
    </aside>
    {menu && <button className="rail-scrim" aria-label="关闭业务导航" onClick={() => { setMenu(false); menuToggle.current?.focus(); }} />}
    <header className="topbar">
      <div className="topbar-title"><button className="menu-toggle" ref={menuToggle} aria-label={menu ? "收起导航" : "展开导航"}
        aria-expanded={menu} aria-controls="staff-navigation" onClick={() => setMenu(!menu)}><Icon name={menu ? "close" : "menu"}/></button>
        <span className="breadcrumb-origin">管理中心</span><span className="breadcrumb-divider">/</span><strong>{activeTab?.label || chosen?.label || "员工工作空间"}</strong></div>
      <div className="topbar-controls">
        {identity.clinics.length > 0 && <div className="scope-control"><Icon name="clinic" size={16}/>
          {identity.clinics.length > 1 ? <select aria-label="工作门店" value={clinicId} onChange={e => changeClinic(e.target.value)}>
            <option value="">全部授权门店</option>
            {identity.clinics.map(clinic => <option key={clinic.clinic_id} value={clinic.clinic_id}>{clinic.name}</option>)}
          </select> : <span>{identity.clinics[0].name}</span>}</div>}
        <button className="logout-button" disabled={loggingOut} onClick={logout} aria-label="退出"><Icon name="logout" size={17}/><span>退出</span></button>
      </div>
    </header>
    <main className="workspace" id="workspace" tabIndex={-1}>
      {fault && <p className="error-text" role="alert">{fault}</p>}
      {chosen ? <div key={identity.account_id + ":" + clinicId} className="workspace-body">
        {tabs.length > 1 && activeGroup?.id !== "desk" && <nav className="workspace-primary-tabs" aria-label={activeGroup?.label}>
          {tabs.map(tab => <a key={tab.path} href={tab.path} aria-current={tab === activeTab ? "page" : undefined}
            onClick={event => navigate(event, tab.path)}>{tab.label}</a>)}
        </nav>}
        {renderWorkArea ? renderWorkArea({section: chosen.path, path, identity, clinicId, open}) : <h1>{chosen.label}</h1>}
      </div> : <section className="schedule-panel"><h1>当前页面无权访问</h1><button className="button" onClick={() => open("/dashboard")}>返回首页</button></section>}
    </main>
  </div>;
}
