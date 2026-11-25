import { MouseEvent, ReactNode, useEffect, useRef, useState } from "react";
import { LoginPage } from "../features/login/LoginPage";
import { ApiError, request } from "./api";
import { Brand, Icon } from "./Icons";
import { allowedSections, navigation, roleNames } from "./navigation";
import type { StaffIdentity } from "./navigation";

export type { StaffIdentity } from "./navigation";
export { canWorkAt } from "./navigation";
export type WorkArea = {
  section: string; path: string; identity: StaffIdentity; clinicId: string; open: (path: string) => void;
};
function isUnder(path: string, area: string) { return path === area || path.startsWith(area + "/"); }
function currentUrl() { return window.location.pathname + window.location.search; }

export function AppShell({ renderWorkArea }: { renderWorkArea?: (area: WorkArea) => ReactNode }) {
  const [identity, setIdentity] = useState<StaffIdentity | null>();
  const [location, setLocation] = useState(currentUrl);
  const [clinicId, setClinicId] = useState("");
  const [fault, setFault] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [menu, setMenu] = useState(false);
  const filterHistory = useRef<Record<string, string>>({});
  const menuToggle = useRef<HTMLButtonElement>(null);
  function open(path: string, replace = false) {
    const previous = navigation.find(area => isUnder(window.location.pathname, area.path));
    if (previous) filterHistory.current[previous.path] = window.location.search;
    if (!path.includes("?") && filterHistory.current[path]) path += filterHistory.current[path];
    if (replace) window.history.replaceState({}, "", path);
    else if (currentUrl() !== path) window.history.pushState({}, "", path);
    setLocation(currentUrl());
    setMenu(false);
  }
  function accept(session: StaffIdentity) {
    if (session.category !== "staff") { setIdentity(null); return; }
    const initialClinic = session.clinics.length === 1 ? session.clinics[0].clinic_id : "";
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
      setIdentity(null); setClinicId(""); setMenu(false); setFault(""); filterHistory.current = {};
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
  const chosen = choices.find(area => isUnder(path, area.path));
  useEffect(() => {
    document.title = (identity ? chosen?.label || "员工工作空间" : "员工登录") + " · ADC 安德鲁牙科";
  }, [identity, chosen?.label]);

  if (identity === null) return <LoginPage onLogin={accept} />;
  if (!identity) return <main className="session-check"><Brand /><p role="status">{fault || "正在核对登录状态…"}</p>
    {fault && <button className="button primary" onClick={() => setAttempt(attempt + 1)}>重试</button>}</main>;

  function changeClinic(next: string) {
    setClinicId(next);
    filterHistory.current = {};
    const root = chosen && allowedSections(identity!, next).includes(chosen) ? chosen.path : "/dashboard";
    // Detail pages and their local filters belong to the previous scope.
    window.history.replaceState({}, "", root);
    setLocation(currentUrl());
  }
  const roles = identity.capabilities.map(role => roleNames[role]).filter(Boolean).join(" · ");
  return <div className="app-layout">
    <a className="skip-link" href="#workspace">跳至工作区</a>
    <aside className={"side-rail" + (menu ? " rail-open" : "")}>
      <a href="/dashboard" className="brand-link" aria-label="ADC 安德鲁牙科工作台" onClick={e => navigate(e, "/dashboard")}><Brand /></a>
      <div className="rail-caption">员工工作空间</div>
      <nav id="staff-navigation" className="side-nav" aria-label="业务导航">
        {choices.map(area => <a key={area.path} href={area.path} onClick={e => navigate(e, area.path)}
          aria-current={chosen === area ? "page" : undefined}><Icon name={area.icon} /><span>{area.label}</span>
          {chosen === area && <span className="active-light" aria-hidden="true" />}</a>)}
      </nav>
      <div className="rail-account"><span className="staff-avatar"><Icon name="user"/></span>
        <div><strong title={roles}>{roles || "员工"}</strong><small>账号 {identity.account_id}</small></div></div>
    </aside>
    {menu && <button className="rail-scrim" aria-label="关闭业务导航" onClick={() => { setMenu(false); menuToggle.current?.focus(); }} />}
    <header className="topbar">
      <div className="topbar-title"><button className="menu-toggle" ref={menuToggle} aria-label={menu ? "收起导航" : "展开导航"}
        aria-expanded={menu} aria-controls="staff-navigation" onClick={() => setMenu(!menu)}><Icon name={menu ? "close" : "menu"}/></button>
        <span className="breadcrumb-origin">管理中心</span><span className="breadcrumb-divider">/</span><strong>{chosen?.label || "员工工作空间"}</strong></div>
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
        {renderWorkArea ? renderWorkArea({section: chosen.path, path, identity, clinicId, open}) : <h1>{chosen.label}</h1>}
      </div> : <section className="schedule-panel"><h1>当前页面无权访问</h1><button className="button" onClick={() => open("/dashboard")}>返回工作台</button></section>}
    </main>
  </div>;
}
