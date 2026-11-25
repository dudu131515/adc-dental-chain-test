import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InvoiceFunds } from "../src/features/billing/InvoiceFunds";
import { OperationsReport } from "../src/features/operations/OperationsReport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

test("reports show both rate numerators and open details using the same query token", async () => {
  const counts = { attended: 4, patient_cancelled: 1, no_show: 1, unprocessed: 2, clinic_cancelled: 1 };
  const rate = (numerator: number, value: string) => ({ numerator, denominator: 8, value, availability: "AVAILABLE" });
  const fetcher = vi.fn(async (path: string) => {
    if (path.includes("/details?")) return response({ as_of: "2030-10-18T12:00:00+08:00", total: 1, next_cursor: null,
      items: [{ appointment_no: "ADC-SAME-SNAPSHOT", status: "CHECKED_IN" }],
    });
    return response({
      date_from: "2030-10-01", date_to: "2030-10-18", as_of: "2030-10-18T12:00:00+08:00", report_token: "same-token",
      scope: { clinic_ids: ["1"], dentist_ids: [] }, sources: {},
      appointments: { ...counts, denominator: 8, attendance_rate: rate(4, "0.5"), cancellation_rate: rate(1, "0.125"),
        by_clinic: [{ ...counts, clinic_id: "1" }],
      },
      clinical: { actual_starts: 4, actual_treatments: 0, normal_completions: 0 },
      standard_coverage: { numerator: 0, denominator: 0, value: null, availability: "NOT_APPLICABLE" },
      financial: { accrued: "0.00", received: "0.00", refunded: "0.00", net_received: "0.00", outstanding: "0.00" },
      skills: [], performance: [],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<OperationsReport clinicId="1" identity={{ account_id: "8", category: "staff", employee_id: "8",
    capabilities: ["HQ_OPERATIONS_QUERY"], clinics: [{ clinic_id: "1", name: "合成甲店" }],
  }} open={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "查询", exact: true }));
  expect(await screen.findByText("4/8")).toBeTruthy();
  expect(screen.getByText("1/8")).toBeTruthy();
  expect(screen.getByText("不适用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "合成甲店 到期未处置 2" }));
  expect(await screen.findByText("ADC-SAME-SNAPSHOT")).toBeTruthy();
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("report_token=same-token&metric=unprocessed&clinic_id=1");
});

test("an unknown invoice collection resolves with the original action key without submitting twice", async () => {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (path.endsWith("/csrf")) return response({ csrf_token: "synthetic-csrf" });
    if (path.endsWith("/payments")) throw new TypeError("simulated disconnect");
    if (path.endsWith("/by-action")) return response({ payment: { payment_id: "15", kind: "PAYMENT", status: "SUCCEEDED" } });
    throw new Error("unexpected request " + path);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<InvoiceFunds invoice={{
    invoice_id: "11", invoice_no: "ADC-BILL", visit_id: "5", appointment_no: "ADC-APPOINTMENT", status: "ISSUED",
    original_total: "120.00", accrued: "120.00", outstanding: "120.00", issued_at: "2031-01-01T10:00:00+08:00",
    clinic_id: "1", lines: [], adjustments: [], payments: [], allowed_actions: ["collect"],
  }} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "填写全部可收金额" }));
  fireEvent.click(screen.getByRole("button", { name: "提交模拟收款" }));
  fireEvent.click(await screen.findByRole("button", { name: "核对原办理结果" }));
  expect(await screen.findByText("诊疗收款 15 · 已成功")).toBeTruthy();
  const posts = fetcher.mock.calls.filter(([path]) => path.endsWith("/payments"));
  const reads = fetcher.mock.calls.filter(([path]) => path.endsWith("/by-action"));
  expect(posts).toHaveLength(1);
  expect(reads).toHaveLength(1);
  const key = (posts[0][1].headers as Headers).get("Idempotency-Key");
  expect(key).toBeTruthy();
  expect((reads[0][1].headers as Headers).get("Idempotency-Key")).toBe(key);
});

test("a lost refund response is reconciled with the same key after reopening the invoice", async () => {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (path.endsWith("/csrf")) return response({ csrf_token: "synthetic-csrf" });
    if (path.endsWith("/refunds")) return new Response("not a business response", { status: 200 });
    if (path.endsWith("/refunds/by-action")) {
      return response({ payment: { payment_id: "16", kind: "REFUND", status: "SUCCEEDED" } });
    }
    throw new Error("unexpected request " + path);
  });
  vi.stubGlobal("fetch", fetcher);
  const invoice = {
    invoice_id: "12", invoice_no: "ADC-BILL", visit_id: "5", appointment_no: "ADC-APPOINTMENT", status: "SETTLED",
    original_total: "120.00", accrued: "90.00", refund_due: "30.00", issued_at: "2031-01-01T10:00:00+08:00",
    clinic_id: "1", lines: [], adjustments: [],
    payments: [{ payment_id: "15", kind: "PAYMENT", status: "SUCCEEDED", amount: "120.00" }], allowed_actions: ["refund"],
  };
  const page = <InvoiceFunds invoice={invoice} accountId="2" onChange={() => {}} />;
  const first = render(page);
  fireEvent.change(screen.getByLabelText("退款原收款"), { target: { value: "15" } });
  fireEvent.change(screen.getByLabelText("退款金额（元）"), { target: { value: "20.00" } });
  fireEvent.click(screen.getByRole("button", { name: "提交原路退款" }));
  await screen.findByRole("button", { name: "核对原办理结果" });
  first.unmount();
  render(page);
  fireEvent.click(await screen.findByRole("button", { name: "核对原办理结果" }));
  expect(await screen.findByText("诊疗退款 16 · 已成功")).toBeTruthy();
  const posts = fetcher.mock.calls.filter(([path]) => path.endsWith("/refunds"));
  const reads = fetcher.mock.calls.filter(([path]) => path.endsWith("/refunds/by-action"));
  expect(posts).toHaveLength(1);
  expect(reads).toHaveLength(1);
  expect((reads[0][1].headers as Headers).get("Idempotency-Key")).toBe((posts[0][1].headers as Headers).get("Idempotency-Key"));
});
