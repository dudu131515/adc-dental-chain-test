import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DashboardPage } from "../src/features/dashboard/DashboardPage";
import type { StaffIdentity } from "../src/shared/AppShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const front: StaffIdentity = {
  account_id: "2", category: "staff", employee_id: "2", capabilities: ["FRONT_DESK"],
  clinics: [{clinic_id: "1", name: "中心门诊"}], role_clinic_ids: {FRONT_DESK: ["1"]},
};

test("the dashboard requests the selected store and business day and links to the same filtered appointments", async () => {
  const url = "/api/v1/appointments?date=2026-11-23&clinic_id=1";
  const row = {
    appointment_id: "10", appointment_no: "ADC-TEST-10", status: "CHECKED_IN",
    start_at: "2026-11-23T08:00:00Z", end_at: "2026-11-23T08:30:00Z",
    clinic: {clinic_id: "1", name: "中心门诊"}, dentist: {name: "林医生"},
    treatment: {name: "口腔检查"}, patient_display: {name: "合成患者"},
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify({data: {items: [row]}})));
  vi.stubGlobal("fetch", fetch);
  window.history.replaceState({}, "", "/dashboard?date=2026-11-23");
  const open = vi.fn();
  render(<DashboardPage section="/dashboard" path="/dashboard" identity={front} clinicId="1" open={open}/>);
  const metric = await screen.findByRole("button", {name: /已签到\s+1\s*笔/});
  expect(fetch).toHaveBeenCalledWith(url, expect.anything());
  fireEvent.click(metric);
  expect(open).toHaveBeenLastCalledWith("/schedule?date=2026-11-23&view=appointments&layout=list&clinic=1&status=CHECKED_IN");
  fireEvent.click(screen.getByRole("button", {name: /合成患者/}));
  expect(open).toHaveBeenLastCalledWith("/schedule/appointments/10?date=2026-11-23&view=appointments&layout=list&clinic=1");
  expect(screen.queryByRole("button", {name: /开始或继续诊疗/})).toBeNull();
});
