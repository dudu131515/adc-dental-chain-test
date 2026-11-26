import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  const group = await screen.findByRole("button", {name:"门诊运营"});
  expect(group.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(group);
  expect(screen.getByRole("link", {name:"预约日历"})).toBeTruthy();
  expect(screen.getByRole("link", {name:"今日门诊"})).toBeTruthy();
  expect(screen.getByRole("link", {name:"跨店排班"})).toBeTruthy();
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
  const group = await screen.findByRole("button", {name:"收费与日结"});
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", {name:"患者与诊疗"})).toBeTruthy();
  const side = screen.getByRole("navigation", {name:"业务导航"});
  expect(within(side).getByRole("link", {name:"日结对账"})).toBeTruthy();
  fireEvent.click(group);
  expect(within(side).queryByRole("link", {name:"日结对账"})).toBeNull();
  expect(screen.getByText("/billing /billing/invoices/7")).toBeTruthy();
});


test("reconciliation filters survive switching to billing and back", async () => {
  window.history.replaceState({}, "", "/billing/reconciliation?clinic_id=1&date=2026-11-03");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({data:{
    account_id:"2", employee_id:"2", category:"staff", capabilities:["FRONT_DESK"],
    clinics:[{clinic_id:"1",name:"合成门店"}], role_clinic_ids:{FRONT_DESK:["1"]},
  }})));
  render(<AppShell />);
  const workTabs = await screen.findByRole("navigation", {name:"收费与日结"});
  const otherTab = within(workTabs).getByRole("link", {name:"结算队列", exact:true});
  fireEvent.click(otherTab);
  expect(window.location.pathname).toBe("/billing");
  expect(window.location.search).toBe("");
  fireEvent.click(within(workTabs).getByRole("link", {name:"日结对账"}));
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

test("focus revalidates staff authorization and clears a revoked work area", async () => {
  const original = {
    account_id: "2", employee_id: "2", category: "staff", capabilities: ["DENTIST"],
    clinics: [{ clinic_id: "1", name: "合成门店" }], role_clinic_ids: { DENTIST: ["1"] },
  };
  let session = original;
  window.history.replaceState({}, "", "/clinical/visits/7");
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify({
    data: url === "/api/v1/auth/me" ? session : {},
  })));
  render(<AppShell renderWorkArea={area => <p>{area.section === "/clinical" ? "合成诊疗详情" : "员工首页"}</p>} />);
  expect(await screen.findByText("合成诊疗详情")).toBeTruthy();
  session = { ...original, capabilities: [], role_clinic_ids: { DENTIST: [] } };
  fireEvent.focus(window);
  expect(await screen.findByText("员工首页")).toBeTruthy();
  expect(screen.queryByText("合成诊疗详情")).toBeNull();
});

test("an older unauthorized response cannot end the workspace after a clinic switch", async () => {
  const session = {
    account_id: "2", employee_id: "2", category: "staff", capabilities: ["FRONT_DESK"],
    clinics: [{ clinic_id: "1", name: "中心门诊" }, { clinic_id: "2", name: "滨江门诊" }],
    role_clinic_ids: { FRONT_DESK: ["1", "2"] },
  };
  let reply: (value: Response) => void = () => {};
  vi.stubGlobal("fetch", (url: string) => {
    if (url === "/api/v1/auth/me") return Promise.resolve(new Response(JSON.stringify({ data: session })));
    if (url.includes("clinic_id=1")) return new Promise<Response>(resolve => { reply = resolve; });
    return Promise.resolve(new Response(JSON.stringify({ data: {} })));
  });
  render(<AppShell renderWorkArea={area => <p>当前门店 {area.clinicId}</p>} />);
  const selector = await screen.findByRole("combobox", { name: "工作门店" });
  fireEvent.change(selector, { target: { value: "1" } });
  expect(screen.getByText("当前门店 1")).toBeTruthy();
  fireEvent.change(selector, { target: { value: "2" } });
  await act(async () => reply(new Response(null, { status: 401 })));
  expect(screen.getByText("当前门店 2")).toBeTruthy();
});

test("one headquarters employee uses scheduling and operations in the same account and workbench", async () => {
  const identity = {
    account_id: "42", employee_id: "42", category: "staff", full_name: "合成总部员工",
    job_code: "HEADQUARTERS", home_clinic: null,
    capabilities: ["HQ_SCHEDULER", "HQ_OPERATIONS_QUERY"],
    clinics: [{ clinic_id: "1", name: "中心门诊" }, { clinic_id: "2", name: "滨江门诊" }],
    role_clinic_ids: { HQ_SCHEDULER: null, HQ_OPERATIONS_QUERY: ["1"] },
  };
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify({
    data: url === "/api/v1/auth/me" ? identity : {},
  })));
  render(<AppShell renderWorkArea={area => <p>{area.section} 员工 {area.identity.employee_id}</p>} />);
  expect(await screen.findByText(/42 · 总部管理人员/)).toBeTruthy();
  const nav = screen.getByRole("navigation", {name:"业务导航"});
  fireEvent.click(within(nav).getByRole("button", {name:"门诊运营"}));
  fireEvent.click(within(nav).getByRole("link", {name:"跨店排班"}));
  expect(screen.getByText("/schedule 员工 42")).toBeTruthy();
  fireEvent.click(within(nav).getByRole("button", {name:"经营与配置"}));
  fireEvent.click(within(nav).getByRole("link", {name:"经营报告"}));
  expect(screen.getByText("/operations 员工 42")).toBeTruthy();
  expect(within(nav).queryByRole("link", {name:"员工与权限"})).toBeNull();
  fireEvent.change(screen.getByRole("combobox", {name:"工作门店"}), {target:{value:"2"}});
  expect(screen.getByText("/dashboard 员工 42")).toBeTruthy();
  expect(within(nav).queryByRole("button", {name:"经营与配置"})).toBeNull();
});

test("a legacy administrator has special authorization while profile details await entry", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: {
    account_id: "42", employee_id: "42", category: "staff",
    capabilities: ["HQ_ACCESS_ADMIN"], clinics: [], role_clinic_ids: { HQ_ACCESS_ADMIN: null },
  } })));
  render(<AppShell />);
  expect(await screen.findByText("管理员权限", {exact:true})).toBeTruthy();
  expect(screen.getByText(/岗位待补录/)).toBeTruthy();
  expect(screen.queryByRole("button", {name:/门诊运营|收费与日结/})).toBeNull();
});

test("a delayed action from a previous clinic does not return the user to its details", async () => {
  const session = {
    account_id: "2", employee_id: "2", category: "staff", capabilities: ["FRONT_DESK"],
    clinics: [{ clinic_id: "1", name: "中心门诊" }, { clinic_id: "2", name: "滨江门诊" }],
    role_clinic_ids: { FRONT_DESK: ["1", "2"] },
  };
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify({ data: url.endsWith("/auth/me") ? session : {} })));
  let complete: () => void = () => {};
  render(<AppShell renderWorkArea={area => <button onClick={() => { complete = () => area.open("/billing/invoices/7"); }}>
    继续办理 {area.clinicId}
  </button>} />);
  const selector = await screen.findByRole("combobox", { name: "工作门店" });
  fireEvent.change(selector, { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button",{name:"继续办理 1"}));
  fireEvent.change(selector, { target: { value: "2" } });
  await act(async () => complete());
  expect(window.location.pathname).toBe("/dashboard");
  expect(screen.getByRole("button",{name:"继续办理 2"})).toBeTruthy();
});
