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


test("existing workbench entries mark actionable items with a dot and no additional task panel", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({data:
    url.includes("/workbench/alerts")
      ? {schedule: true, clinical: false, billing: true, corrections: false}
      : {items: []},
  })));
  vi.stubGlobal("fetch", fetch);
  const open = vi.fn();
  render(<DashboardPage section="/dashboard" path="/dashboard" identity={front} clinicId="1" open={open}/>);
  const billing = await screen.findByRole("button", {name: /结算队列.*有待办/});
  expect(billing.querySelector(".desk-pending-dot")).toBeTruthy();
  expect(screen.getByRole("button", {name: /完整日历.*有待办/}).querySelector(".desk-pending-dot")).toBeTruthy();
  expect(screen.queryByRole("heading", {name: "待处理"})).toBeNull();
  fireEvent.click(billing);
  expect(open).toHaveBeenLastCalledWith("/billing");
});

test("the existing billing shortcut opens reconciliation when only deposit work is waiting", async () => {
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify({data:
    url.includes("/workbench/alerts")
      ? {schedule: false, clinical: false, billing: false, corrections: false, reconciliation: true}
      : {items: []},
  })));
  window.history.replaceState({}, "", "/dashboard?date=2026-11-23");
  const open = vi.fn();
  render(<DashboardPage section="/dashboard" path="/dashboard" identity={front} clinicId="1" open={open}/>);
  const billing = await screen.findByRole("button", {name: /结算队列.*有待办/});
  fireEvent.click(billing);
  expect(open).toHaveBeenCalledWith("/billing/reconciliation?date=2026-11-23&clinic_id=1");
});

test("refresh denies old appointment names and dots when the workbench scope is revoked", async () => {
  let revoked = false;
  const row = {
    appointment_id: "10", appointment_no: "ADC-TEST-10", status: "CHECKED_IN",
    start_at: "2026-11-23T08:00:00Z", end_at: "2026-11-23T08:30:00Z",
    clinic: {clinic_id: "1", name: "中心门诊"}, dentist: {name: "林医生"},
    treatment: {name: "口腔检查"}, patient_display: {name: "旧授权内合成患者"},
  };
  vi.stubGlobal("fetch", async (url: string) => revoked
    ? new Response(JSON.stringify({error:{code:"PERMISSION_DENIED",message:"范围已变更"}}), {status:403})
    : new Response(JSON.stringify({data:url.includes("/workbench/alerts")
      ? {schedule:true, clinical:false, billing:false, reconciliation:false, corrections:false}
      : {items:[row]}})));
  render(<DashboardPage section="/dashboard" path="/dashboard" identity={front} clinicId="1" open={vi.fn()}/>);
  await screen.findByRole("button", {name:/旧授权内合成患者/});
  await screen.findByRole("button", {name:/完整日历.*有待办/});
  revoked = true;
  fireEvent.click(screen.getByRole("button", {name:"刷新"}));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", {name:/旧授权内合成患者/})).toBeNull();
  expect(screen.queryByRole("button", {name:/完整日历.*有待办/})).toBeNull();
});
