import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AppShell } from "../src/shared/AppShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

test("an authorized scheduler opens the schedule and sees only authorized sections", async () => {
  window.history.replaceState({}, "", "/billing");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    data: {
      account_id: "32", category: "staff", employee_id: "17",
      capabilities: ["HQ_SCHEDULER"], clinics: [{clinic_id: "1", name: "合成门店"}],
    },
  }), { status: 200 }));
  render(<AppShell />);
  await screen.findByRole("link", { name: "排班与预约" });
  expect(screen.queryByRole("link", { name: "结算" })).toBeNull();
  expect(window.location.pathname).toBe("/dashboard");
  expect(screen.getByText("合成门店")).toBeTruthy();
});

test("an expired session shows the website sign-in form", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    error: { code: "AUTHENTICATION_REQUIRED", message: "请登录后继续。", request_id: "test" },
  }), { status: 401 }));
  render(<AppShell />);
  expect(await screen.findByRole("button", { name: "登录" })).toBeTruthy();
  expect(screen.queryByRole("navigation")).toBeNull();
});


test("the staff navigation groups existing URLs, and a billing URL still opens the original work area", async () => {
  window.history.replaceState({}, "", "/billing/invoices/7");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({data:{
    account_id:"2", employee_id:"2", category:"staff", capabilities:["FRONT_DESK"],
    clinics:[{clinic_id:"1",name:"合成门店"}], role_clinic_ids:{FRONT_DESK:["1"]},
  }})));
  render(<AppShell renderWorkArea={area => <p>{area.section} {area.path}</p>}/>);
  const group = await screen.findByRole("link", {name:"收费与经营"});
  expect(group.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", {name:"患者与诊疗"})).toBeTruthy();
  expect(screen.getByRole("link", {name:"日结对账"})).toBeTruthy();
  expect(screen.getByText("/billing /billing/invoices/7")).toBeTruthy();
});


test("reconciliation filters survive switching to billing and back", async () => {
  window.history.replaceState({}, "", "/billing/reconciliation?clinic_id=1&date=2026-11-03");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({data:{
    account_id:"2", employee_id:"2", category:"staff", capabilities:["FRONT_DESK"],
    clinics:[{clinic_id:"1",name:"合成门店"}], role_clinic_ids:{FRONT_DESK:["1"]},
  }})));
  render(<AppShell />);
  const otherTab = await screen.findByRole("link", {name:"结算", exact:true});
  fireEvent.click(otherTab);
  expect(window.location.pathname).toBe("/billing");
  expect(window.location.search).toBe("");
  fireEvent.click(screen.getByRole("link", {name:"日结对账"}));
  expect(window.location.pathname).toBe("/billing/reconciliation");
  expect(window.location.search).toBe("?clinic_id=1&date=2026-11-03");
});

test("a multi-clinic employee retains their selected scope when the app reloads", async () => {
  window.history.replaceState({}, "", "/dashboard?date=2026-11-24");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({data:{
    account_id:"2", employee_id:"2", category:"staff", capabilities:["FRONT_DESK"],
    clinics:[{clinic_id:"1",name:"中心门诊"}, {clinic_id:"2",name:"滨江门诊"}], role_clinic_ids:{FRONT_DESK:["1","2"]},
  }})));
  const renderArea = (area: {clinicId: string}) => <p>范围 {area.clinicId}</p>;
  const first = render(<AppShell renderWorkArea={renderArea}/>);
  const select = await screen.findByRole("combobox", {name:"工作门店"});
  fireEvent.change(select, {target:{value:"2"}});
  expect(screen.getByText("范围 2")).toBeTruthy();
  first.unmount();
  render(<AppShell renderWorkArea={renderArea}/>);
  expect(await screen.findByText("范围 2")).toBeTruthy();
  expect(window.location.search).toBe("?date=2026-11-24");
});
