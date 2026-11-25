import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BookingForm } from "../src/features/schedule/BookingForm";
import type { StaffIdentity } from "../src/shared/navigation";

const identity: StaffIdentity = {
  account_id: "1", employee_id: "2", category: "staff", capabilities: ["FRONT_DESK"],
  clinics: [{ clinic_id: "3", name: "合成甲店" }, { clinic_id: "4", name: "合成乙店" }],
};
const patient = { patient_id: "5", patient_no: "synthetic", full_name: "合成患者姓名", phone: "12345678", birth_date: "1970-01-01" };
const date = "2031-01-01";
const candidate = {
  clinic_id: "3", dentist_id: "6", dentist_name: "合成牙医", shift_id: "7", treatment_type_id: "8",
  start_at: date + "T10:00:00+08:00", end_at: date + "T10:30:00+08:00",
};
const deposit = { deposit_id: "9", amount: "50.00" };
const hold = () => ({
  claim_id: "10", status: "HOLD", start_at: candidate.start_at,
  expires_at: new Date(Date.now() + 600_000).toISOString(), server_time: new Date().toISOString(),
  payment: { ...deposit, status: "NOT_STARTED" },
});
const page = (account = identity, clinic = "3") =>
  <BookingForm identity={account} clinic={clinic} date={date} initialPatient={patient} onAppointment={() => {}} />;

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}
function mockFetch(handle: (path: string, options: RequestInit) => Response) {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (path.endsWith("/csrf")) return response({ csrf_token: "test" });
    if (path.endsWith("/catalog/treatments")) return response({ items: [
      { treatment_type_id: "8", treatment_name: "初诊检查", active: true, default_slot_minutes: 30 },
    ] });
    if (path.includes("/schedule/dentists?")) return response({ items: [] });
    if (path.includes("/booking/options?")) return response({ items: [candidate] });
    return handle(path, options);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function reserve(note?: string) {
  await screen.findByRole("option", { name: "初诊检查" });
  fireEvent.change(screen.getByLabelText("主诊项目"), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "查询可约时段" }));
  fireEvent.click(await screen.findByRole("button", { name: /合成牙医/ }));
  if (note) fireEvent.change(screen.getByLabelText("特殊需求（选填）"), { target: { value: note } });
  fireEvent.click(screen.getByRole("button", { name: "确认临时占位" }));
}
const actionKey = (options: RequestInit) => (options.headers as Headers).get("Idempotency-Key");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

test("an original hold is recovered after reopening and payment uses the latest read", async () => {
  const fetcher = mockFetch(path => {
    if (path.endsWith("/holds")) return response(hold());
    if (path.includes("/holds/by-action?")) return response(hold());
    if (path.endsWith("/deposit-payments/9")) {
      return response({ ...deposit, status: "PAID", claim_status: "RELEASED", refund: { amount: "50.00", status: "PENDING" } });
    }
    throw new Error(path);
  });
  const first = render(page());
  await reserve();
  await screen.findByRole("button", { name: "提交模拟预约金付款" });
  first.unmount();

  const different = render(page({ ...identity, account_id: "99" }));
  expect(screen.queryByRole("button", { name: "核对原预约占位" })).toBeNull();
  different.unmount();
  const otherClinic = render(page(identity, "4"));
  expect(screen.queryByRole("button", { name: "核对原预约占位" })).toBeNull();
  otherClinic.unmount();

  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "核对原预约占位" }));
  expect(await screen.findByText(/原路退金.*处理中/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "提交模拟预约金付款" })).toBeNull();
  const post = fetcher.mock.calls.find(([path]) => path.endsWith("/holds"))!;
  const lookup = fetcher.mock.calls.find(([path]) => path.includes("/holds/by-action?"))!;
  expect(actionKey(lookup[1])).toBe(actionKey(post[1]));
  expect(lookup[0]).toContain("clinic_id=3&patient_id=5");
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/holds"))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/deposit-payments/9"))).toHaveLength(1);
});

test("a missing original result reuses the exact persisted hold key and body", async () => {
  let writes = 0;
  const fetcher = mockFetch(path => {
    if (path.endsWith("/holds")) {
      if (++writes === 1) throw new TypeError("simulated disconnect");
      return response(hold());
    }
    if (path.includes("/holds/by-action?")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    throw new Error(path);
  });
  const first = render(page());
  await reserve();
  await screen.findByRole("button", { name: "核对原办理结果" });
  first.unmount();

  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "核对原预约占位" }));
  fireEvent.click(await screen.findByRole("button", { name: "按原资料重试占位" }));
  expect(await screen.findByRole("heading", { name: "确认预约金" })).toBeTruthy();
  const events = fetcher.mock.calls.filter(([path]) => path.endsWith("/holds") || path.includes("/holds/by-action?"));
  expect(events.map(([, options]) => options.method)).toEqual(["POST", "GET", "GET", "POST"]);
  expect(new Set(events.map(([, options]) => actionKey(options))).size).toBe(1);
  expect(events.at(-1)![1].body).toBe(events[0][1].body);
  const saved = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join();
  expect(saved).not.toContain(patient.full_name);
  expect(saved).not.toContain(patient.phone);
});


test("clinical text stays out of storage and an exact re-entry is required before retry", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const note = "合成特殊需求原文";
  let writes = 0;
  const fetcher = mockFetch(path => {
    if (path.endsWith("/holds")) {
      if (++writes === 1) throw new TypeError("simulated disconnect");
      return response(hold());
    }
    if (path.includes("/holds/by-action?")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    throw new Error(path);
  });
  const first = render(page());
  await reserve(note);
  await screen.findByRole("button", { name: "核对原办理结果" });
  first.unmount();

  const saved = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join();
  expect(saved).not.toContain(note);
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "核对原预约占位" }));
  const retry = await screen.findByRole("button", { name: "按原资料重试占位" });
  const originalNote = screen.getByLabelText("原特殊需求");
  fireEvent.change(originalNote, { target: { value: "错误资料" } });
  fireEvent.click(retry);
  expect((await screen.findByRole("alert")).textContent).toContain("输入与原操作不一致");
  expect(writes).toBe(1);

  fireEvent.change(originalNote, { target: { value: note } });
  fireEvent.click(retry);
  expect(await screen.findByRole("heading", { name: "确认预约金" })).toBeTruthy();
  const posts = fetcher.mock.calls.filter(([path]) => path.endsWith("/holds"));
  expect(posts).toHaveLength(2);
  expect(posts[1][1].body).toBe(posts[0][1].body);
  expect(actionKey(posts[1][1])).toBe(actionKey(posts[0][1]));
});


test("an active hold can be released while payment is pending and keeps the original refund", async () => {
  const fetcher = mockFetch(path => {
    if (path.endsWith("/holds")) return response(hold());
    if (path.endsWith("/simulate")) return response({ ...deposit, status: "PENDING", claim_status: "HOLD" });
    if (path.endsWith("/holds/10/release")) return response({ ...hold(), status: "RELEASED", payment: { ...deposit, status: "PENDING" } });
    if (path.endsWith("/deposit-payments/9")) return response({
      ...deposit, status: "PAID", claim_status: "RELEASED", refund: { amount: "50.00", status: "PENDING" },
    });
    throw new Error(path);
  });
  render(page());
  await reserve();
  fireEvent.click(await screen.findByRole("button", { name: "提交模拟预约金付款" }));
  fireEvent.click(await screen.findByRole("button", { name: "释放占位并继续跟踪付款与退金" }));
  expect(await screen.findByText(/原路退金.*处理中/)).toBeTruthy();
  const paths = fetcher.mock.calls.map(([path]) => path);
  expect(paths.filter(path => path.endsWith("/release"))).toEqual(["/api/v1/holds/10/release"]);
  expect(paths.at(-1)).toBe("/api/v1/deposit-payments/9");
});
