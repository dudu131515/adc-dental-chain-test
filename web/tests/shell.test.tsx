import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AppShell } from "../src/shared/AppShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
