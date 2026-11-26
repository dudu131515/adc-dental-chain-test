import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { WorkArea } from "../../shared/AppShell";
import { AccessPage } from "./AccessPage";

const admin: WorkArea = {
  section: "/admin", path: "/admin/access", clinicId: "", open: () => {},
  identity: {
    category: "staff", account_id: "1", employee_id: "1", capabilities: ["HQ_ACCESS_ADMIN"],
    clinics: [], role_clinic_ids: { HQ_ACCESS_ADMIN: null },
  },
};

const clinic = { clinic_id: "20", clinic_no: "A", name: "合成甲门店", status: "ACTIVE" };
const directory = {
  clinics: [clinic],
  roles: [{ role_code: "FRONT_DESK", role_name: "诊所前台" }],
  employees: [{
    employee_id: "9", employee_no: "SYN-9", full_name: "合成员工", employee_status: "ACTIVE", account_status: "ACTIVE",
    can_manage_account: true, can_manage_grants: true, grants: [],
  }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("clinic editing keeps the existing record and refreshes the directory", async () => {
  let record = { ...clinic, address: "合成地址", phone: "000", email: null };
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/csrf")) return Response.json({ data: { csrf_token: "fake" } });
    if (options.method === "PATCH") {
      record = { ...record, ...JSON.parse(String(options.body)) };
      return Response.json({ data: record });
    }
    return Response.json({ data: { items: [record] } });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<AccessPage {...admin} path="/admin/clinics" />);
  expect(await screen.findByText("合成地址")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑门店" }));
  expect(screen.getByRole("dialog", { name: "编辑门店" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("地址"), { target: { value: "更新后地址" } });
  fireEvent.change(screen.getByLabelText("门店状态", { selector: "select" }), { target: { value: "INACTIVE" } });
  fireEvent.click(screen.getByRole("button", { name: "保存门店" }));
  expect(await screen.findByText("更新后地址")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  const write = fetcher.mock.calls.find(([, options]) => options.method === "PATCH");
  expect(write?.[0]).toBe("/api/v1/admin/clinics/20");
  expect(JSON.parse(String(write?.[1].body))).toEqual({ address: "更新后地址", status: "INACTIVE" });
});

test("employee creation records placement and allows a separate account to be configured", async () => {
  const employee = {
    employee_id: "10", employee_no: "SYN-10", full_name: "新增合成员工", employee_status: "ACTIVE",
    account_status: null as string | null, job_code: "HEADQUARTERS", home_clinic: null,
    can_manage_account: false, can_manage_grants: true, can_manage_profile: true, grants: [],
  };
  let created = false;
  const mutations: { path: string; body: unknown; key: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    if (url.endsWith("/csrf")) return Response.json({ data: { csrf_token: "fake" } });
    if (url.endsWith("/history")) return Response.json({ data: { items: [] } });
    if (options.method === "POST") {
      mutations.push({ path: url, body: JSON.parse(String(options.body)), key: (options.headers as Headers).get("Idempotency-Key") });
      if (url.endsWith("/account")) {
        employee.account_status = "ACTIVE";
        employee.can_manage_account = true;
      } else {
        created = true;
      }
      return Response.json({ data: { employee_id: employee.employee_id } });
    }
    return Response.json({ data: { ...directory, employees: created ? [...directory.employees, employee] : directory.employees } });
  });
  render(<AccessPage {...admin} />);
  await screen.findByRole("button", { name: "合成员工" });
  fireEvent.click(screen.getByRole("button", { name: "新增员工" }));
  const create = within(screen.getByRole("dialog", { name: "新增员工" }));
  fireEvent.change(create.getByLabelText("工号"), { target: { value: "SYN-10" } });
  fireEvent.change(create.getByLabelText("姓名"), { target: { value: "新增合成员工" } });
  fireEvent.change(create.getByLabelText("所属岗位"), { target: { value: "HEADQUARTERS" } });
  fireEvent.click(create.getByRole("button", { name: "保存员工" }));
  const editor = within(await screen.findByRole("dialog", { name: "新增合成员工 · SYN-10" }));
  fireEvent.click(editor.getByRole("button", { name: "配置登录账号" }));
  fireEvent.change(editor.getByLabelText("登录名"), { target: { value: "synthetic.10" } });
  fireEvent.change(editor.getByLabelText(/初始密码/), { target: { value: "Synthetic-Demo-10" } });
  fireEvent.click(editor.getByRole("button", { name: "保存登录账号" }));
  expect(await editor.findByRole("button", { name: "停用账号" })).toBeTruthy();
  expect(mutations.map(({ key, ...mutation }) => {
    expect(key).toBeTruthy();
    return mutation;
  })).toEqual([
    {
      path: "/api/v1/admin/access/employees",
      body: { employee_no: "SYN-10", full_name: "新增合成员工", job_code: "HEADQUARTERS", home_clinic_id: null },
    },
    {
      path: "/api/v1/admin/access/employees/10/account",
      body: { login_identity: "synthetic.10", password: "Synthetic-Demo-10" },
    },
  ]);
});

test("global catalog access can restore a disabled chair without editing its other fields", async () => {
  const catalog = {
    ...admin,
    identity: { ...admin.identity, capabilities: ["HQ_CATALOG"], role_clinic_ids: { HQ_CATALOG: null } },
    path: "/admin/chairs",
  };
  const chair = {
    chair_id: "2", chair_no: "SYN-C2", clinic_id: clinic.clinic_id, clinic_name: clinic.name,
    chair_kind: "GENERAL", status: "INACTIVE",
  };
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/csrf")) return Response.json({ data: { csrf_token: "fake" } });
    if (options.method === "PATCH") {
      Object.assign(chair, JSON.parse(String(options.body)));
      return Response.json({ data: chair });
    }
    return Response.json({ data: { items: [chair], clinics: [clinic] } });
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<AccessPage {...catalog} />);
  expect(await screen.findByText("SYN-C2")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("状态筛选"), { target: { value: "AVAILABLE" } });
  expect(screen.queryByText("SYN-C2")).toBeNull();
  fireEvent.change(screen.getByLabelText("状态筛选"), { target: { value: "INACTIVE" } });
  fireEvent.click(screen.getByRole("button", { name: "编辑牙椅" }));
  fireEvent.change(screen.getByLabelText("使用状态"), { target: { value: "AVAILABLE" } });
  fireEvent.click(screen.getByRole("button", { name: "保存牙椅" }));
  await screen.findByText("牙椅已保存。");
  const write = fetcher.mock.calls.find(([, options]) => options.method === "PATCH");
  expect(write?.[0]).toBe("/api/v1/admin/chairs/2");
  expect(JSON.parse(String(write?.[1].body))).toEqual({ status: "AVAILABLE" });
  view.rerender(<AccessPage {...catalog} path="/admin/access" />);
  expect(screen.getByRole("heading", { name: "当前页面无权访问" })).toBeTruthy();
  expect(fetcher.mock.calls.every(([url]) => !url.endsWith("/admin/access"))).toBe(true);
});

test("a material cost replacement posts the exact decimal and original version boundary", async () => {
  const material = {
    material_id: "123", material_code: "SYN-M", material_name: "合成耗材",
    standard_unit: "份", status: "ACTIVE", current_unit_cost: "4.20",
  };
  const costs = [{ cost_id: "6", material_id: "123", unit_cost: "4.20", effective_from: "2026-01-01", effective_to: null }];
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/csrf")) return Response.json({ data: { csrf_token: "fake" } });
    if (options.method === "POST") return Response.json({ data: { cost_id: "7" } });
    return Response.json({ data: { items: url.endsWith("/costs") ? costs : [material] } });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<AccessPage {...admin} path="/admin/materials" />);
  fireEvent.click(await screen.findByRole("button", { name: "成本版本" }));
  const dialog = within(screen.getByRole("dialog", { name: "合成耗材" }));
  await dialog.findByText("¥4.20");
  fireEvent.change(dialog.getByLabelText("单位成本（元）"), { target: { value: "5.30" } });
  fireEvent.change(dialog.getByLabelText("生效日期"), { target: { value: "2026-12-01" } });
  fireEvent.change(dialog.getByLabelText("同时结束原版本"), { target: { value: "6" } });
  fireEvent.click(dialog.getByRole("button", { name: "保存成本版本" }));
  await waitFor(() => {
    const write = fetcher.mock.calls.find(([, options]) => options.method === "POST");
    expect(write?.[0]).toBe("/api/v1/admin/materials/123/costs");
    expect(JSON.parse(String(write?.[1].body))).toEqual({
      unit_cost: "5.30", effective_from: "2026-12-01", effective_to: null, replace_cost_id: "6", replace_effective_to: "2026-12-01",
    });
  });
});

test("grant recovery keeps the operation key and reloads the result after a successful retry", async () => {
  const operations: { key: string | null; body: unknown }[] = [];
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/history")) return Response.json({ data: { items: [] } });
    if (url.endsWith("/csrf")) return Response.json({ data: { csrf_token: "fake" } });
    if (url.endsWith("/grants")) {
      operations.push({ key: (options.headers as Headers).get("Idempotency-Key"), body: JSON.parse(String(options.body)) });
      if (operations.length === 1) throw new Error("interrupted");
      return Response.json({ data: { employee_id: "9", role_code: "FRONT_DESK", clinic_id: "20", granted: true } });
    }
    return Response.json({ data: directory });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<AccessPage {...admin} />);
  fireEvent.click(await screen.findByRole("button", { name: "合成员工" }));
  fireEvent.change(screen.getByLabelText("授权门店"), { target: { value: "20" } });
  fireEvent.change(screen.getByLabelText("功能权限"), { target: { value: "FRONT_DESK" } });
  fireEvent.change(screen.getByLabelText("授权变更原因"), { target: { value: "合成排班" } });
  fireEvent.click(screen.getByRole("button", { name: "授予权限" }));
  fireEvent.click(await screen.findByRole("button", { name: "核对原办理结果" }));
  expect(await screen.findByText("门店授权已更新。")).toBeTruthy();
  expect(operations[0].key).toBeTruthy();
  expect(operations).toEqual([operations[0], operations[0]]);
  expect(operations[0].body).toEqual({
    role_code: "FRONT_DESK", clinic_id: "20", expected_granted: false, granted: true, reason: "合成排班",
  });
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/admin/access"))).toHaveLength(2));
});

test("an account status conflict leaves a visible way to read the latest state", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/history")) return Response.json({ data: { items: [] } });
    if (url.endsWith("/csrf")) return Response.json({ data: { csrf_token: "fake" } });
    if (url.endsWith("/account-status")) return Response.json({
      error: { code: "STALE_ACCESS_STATE", message: "资料已更新，请重新查询后再提交。" },
    }, { status: 409 });
    return Response.json({ data: directory });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<AccessPage {...admin} />);
  fireEvent.click(await screen.findByRole("button", { name: "合成员工" }));
  fireEvent.change(screen.getByLabelText("账号变更原因"), { target: { value: "合成离岗" } });
  fireEvent.click(screen.getByRole("button", { name: "停用账号" }));
  expect((await screen.findByRole("alert")).textContent).toBe("资料已更新，请重新查询后再提交。");
  fireEvent.click(screen.getByRole("button", { name: "重新查询" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/admin/access"))).toHaveLength(2));
});
