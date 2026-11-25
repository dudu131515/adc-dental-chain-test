import { useState } from "react";
import type { WorkArea } from "../../shared/AppShell";
import { AppointmentCalendar } from "./AppointmentCalendar";
import { ResourceImpactPanel } from "./ResourceImpactPanel";
import { ShiftBoard } from "./ShiftBoard";
import { ShiftDemandForm } from "./ShiftDemandForm";
import { localDate } from "./types";
import "./schedule.css";

type Tab = "appointments" | "shifts" | "demands" | "resources";

export function SchedulePage(props: WorkArea) {
  const canPlan = props.identity.capabilities.includes("HQ_SCHEDULER");
  const managesClinic = props.identity.capabilities.includes("CLINIC_MANAGER");
  const canRespond = props.identity.capabilities.includes("DENTIST");
  const tabs: { id: Tab; label: string }[] = [{ id: "appointments", label: "预约日历" }];
  if (canPlan || managesClinic || canRespond) tabs.push({ id: "shifts", label: "跨店排班" });
  if (canPlan || managesClinic) {
    tabs.push({ id: "demands", label: "排班需求" }, { id: "resources", label: "牙椅停用" });
  }
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    return tabs.find(view => view.id === requested)?.id || "appointments";
  });
  const active = props.path.startsWith("/schedule/appointments/") ? "appointments" : tab;

  function choose(id: Tab) {
    const params = new URLSearchParams(window.location.search);
    params.set("view", id);
    if (props.path !== "/schedule") props.open("/schedule?" + params.toString());
    else window.history.replaceState({}, "", window.location.pathname + "?" + params.toString());
    setTab(id);
  }

  function affected(id: string, start: string) {
    const params = new URLSearchParams(window.location.search);
    params.set("date", localDate(start));
    params.set("view", "appointments");
    setTab("appointments");
    props.open("/schedule/appointments/" + id + "?" + params.toString());
  }

  return <div className="schedule-page">
    <h1>排班与预约</h1>
    <nav className="schedule-tabs" aria-label="排班与预约">
      {tabs.map(view => <button key={view.id} className="button" aria-pressed={active === view.id}
        onClick={() => choose(view.id)}>{view.label}</button>)}
    </nav>
    {active === "appointments" && <AppointmentCalendar {...props} />}
    {active === "shifts" && <ShiftBoard {...props} onAppointment={affected} />}
    {active === "demands" && <ShiftDemandForm {...props} />}
    {active === "resources" && <ResourceImpactPanel {...props} onAppointment={affected} />}
  </div>;
}
