import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

test("the clinic directory is read-only and uses the authorized clinic endpoint", async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json({ data: {
    items: [{ ...clinic, address: "合成地址", phone: "000", email: null }],
  } }));
  vi.stubGlobal("fetch", fetcher);
  render(<AccessPage {...admin} path="/admin/clinics" />);
  expect(await screen.findByText("合成地址")).toBeTruthy();
  expect(screen.queryByText("合成员工")).toBeNull();
  expect(fetcher.mock.calls).toEqual([["/api/v1/admin/clinics", expect.any(Object)]]);
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
  fireEvent.change(screen.getByLabelText("预设角色"), { target: { value: "FRONT_DESK" } });
  fireEvent.change(screen.getByLabelText("授权变更原因"), { target: { value: "合成排班" } });
  fireEvent.click(screen.getByRole("button", { name: "授予角色" }));
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
