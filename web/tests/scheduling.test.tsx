import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { ShiftBoard } from "../src/features/schedule/ShiftBoard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

test("the week view shows dentist, clinic, time and status from the scoped board", async () => {
  window.history.replaceState({}, "", "/schedule?week=2030-10-14");
  vi.stubGlobal("fetch", async (input: string) => {
    const data = input.includes("/schedule/dentists")
      ? { items: [{ dentist_id: "7", name: "合成牙医", qualifications: [] }] }
      : {
          shifts: [{
            shift_id: "22", clinic_id: "1", dentist_id: "7",
            start_at: "2030-10-14T09:00:00+08:00", end_at: "2030-10-14T10:00:00+08:00", status: "PUBLISHED",
          }],
          appointments: [],
        };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  render(<ShiftBoard clinicId="" identity={{
    account_id: "4", category: "staff", employee_id: "12", capabilities: ["HQ_SCHEDULER"],
    clinics: [{ clinic_id: "1", name: "合成甲店" }],
  }} />);
  expect(await screen.findByRole("rowheader", { name: "合成牙医" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: /09:00.*合成甲店.*已发布/ })).toBeTruthy();
});
