import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppointmentCalendar } from "../src/features/schedule/AppointmentCalendar";
import type { StaffIdentity } from "../src/shared/AppShell";

const identity: StaffIdentity = {
  account_id: "7", employee_id: "7", category: "staff", capabilities: ["FRONT_DESK"],
  clinics: [{ clinic_id: "1", name: "合成甲店" }], role_clinic_ids: { FRONT_DESK: ["1"] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

test("published shifts without appointments offer a prefilled booking preference and real options check", async () => {
  window.history.replaceState({}, "", "/schedule?date=2035-06-04&clinic=1&status=CANCELLED");
  let options: URLSearchParams | undefined;
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, window.location.origin);
    const day = "2035-06-04T";
    const shift = (id: string, dentist: string, status: string) => ({
      shift_id: id, dentist_id: dentist, clinic_id: "1", status,
      start_at: day + "09:00:00+08:00", end_at: day + "10:00:00+08:00",
    });
    const response = (data: unknown) => new Response(JSON.stringify({ data }));
    if (url.pathname.endsWith("/schedule/board")) return response({
      shifts: [shift("1", "4", "PUBLISHED"), shift("2", "5", "PUBLISHED"), shift("3", "6", "DRAFT")],
      appointments: [{
        appointment_id: "80", appointment_no: "ADC-80", clinic_id: "1", dentist_id: "4", status: "CONFIRMED",
        start_at: day + "09:00:00+08:00", end_at: day + "09:30:00+08:00", patient_display: "已预约患者",
      }],
    });
    if (url.pathname.endsWith("/schedule/dentists")) return response({ items: [
      { dentist_id: "4", name: "已有预约牙医" }, { dentist_id: "5", name: "合成空班牙医" }, { dentist_id: "6", name: "草案牙医" },
    ] });
    if (url.pathname.endsWith("/catalog/treatments")) return response({
      items: [{ treatment_type_id: "21", treatment_name: "合成检查", default_slot_minutes: 30, active: true }],
    });
    if (url.pathname.endsWith("/patients")) return response({
      items: [{ patient_id: "6", patient_no: "ADC-6", full_name: "合成患者甲", birth_date: "2000-01-01", phone: "00000000000" }],
    });
    if (url.pathname.endsWith("/booking/options")) { options = url.searchParams; return response({ items: [] }); }
    return response({ items: [] });
  });
  render(<AppointmentCalendar identity={identity} clinicId="1" path="/schedule" section="/schedule" open={() => {}} />);
  const row = await screen.findByRole("region", { name: "合成空班牙医" });
  expect(within(row).getByText("09:00–10:00", { exact: true })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "草案牙医" })).toBeNull();
  const occupied = screen.getByRole("region", { name: "已有预约牙医" });
  expect(within(occupied).queryByRole("button", { name: /09:00.*候选空档/ })).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: /09:00.*候选空档/ }));
  const booking = await screen.findByRole("complementary", { name: "代办预约" });
  await within(booking).findByRole("option", { name: "合成空班牙医" });
  expect((within(booking).getByLabelText("牙医") as HTMLSelectElement).value).toBe("5");
  expect((within(booking).getByLabelText("意向开始时间") as HTMLInputElement).value).toBe("09:00");
  fireEvent.change(within(booking).getByLabelText("查找本店患者"), { target: { value: "合成患者甲" } });
  fireEvent.click(within(booking).getByRole("button", { name: "查找", exact: true }));
  fireEvent.click(await within(booking).findByRole("button", { name: /合成患者甲.*ADC-6/ }));
  fireEvent.change(within(booking).getByLabelText("主诊项目"), { target: { value: "21" } });
  fireEvent.click(within(booking).getByRole("button", { name: "查询可约时段" }));
  expect(await within(booking).findByText("没有符合条件的时段。")).toBeTruthy();
  expect(Object.fromEntries(options ?? [])).toEqual({
    clinic_id: "1", date: "2035-06-04", treatment_type_id: "21", dentist_id: "5",
    preferred_start_at: "2035-06-04T09:00:00+08:00",
  });
});
