import type { WorkArea } from "../../shared/AppShell";
import { hasRole } from "../../shared/navigation";
import { AppointmentCalendar } from "./AppointmentCalendar";
import { ResourceImpactPanel } from "./ResourceImpactPanel";
import { ShiftBoard } from "./ShiftBoard";
import { ShiftDemandForm } from "./ShiftDemandForm";
import { localDate } from "./types";
import "./schedule.css";

type Tab = "appointments" | "shifts" | "demands" | "resources";

export function SchedulePage(props: WorkArea) {
  const {identity, clinicId} = props;
  const canPlan = hasRole(identity, ["HQ_SCHEDULER"], clinicId);
  const managesClinic = hasRole(identity, ["CLINIC_MANAGER"], clinicId);
  const canRespond = hasRole(identity, ["DENTIST"], clinicId);
  const tabs: { id: Tab; label: string }[] = [{ id: "appointments", label: "预约日历" }];
  if (canPlan || managesClinic || canRespond) tabs.push({ id: "shifts", label: "跨店排班" });
  if (canPlan || managesClinic) {
    tabs.push({ id: "demands", label: "排班需求" }, { id: "resources", label: "牙椅停用" });
  }
  const requested = new URLSearchParams(window.location.search).get("view");
  const active = props.path.startsWith("/schedule/appointments/")
    ? "appointments" : tabs.find(view => view.id === requested)?.id || "appointments";

  function choose(id: Tab) {
    const params = new URLSearchParams(window.location.search);
    params.set("view", id);
    props.open("/schedule?" + params.toString());
  }

  function affected(id: string, start: string) {
    const params = new URLSearchParams(window.location.search);
    params.set("date", localDate(start));
    params.set("view", "appointments");
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
