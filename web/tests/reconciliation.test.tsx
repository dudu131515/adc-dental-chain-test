import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DailyReconciliation } from "../src/features/billing/DailyReconciliation";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

const identity = {
  account_id: "8", category: "staff" as const, employee_id: "8", capabilities: ["FRONT_DESK"],
  clinics: [{ clinic_id: "1", name: "合成甲店" }, { clinic_id: "2", name: "合成乙店" }],
  role_clinic_ids: { FRONT_DESK: ["1"] },
};

function response(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status });
}

test("daily reconciliation keeps historical receipts and current obligations separate", async () => {
  const open = vi.fn();
  const fetcher = vi.fn(async (_path: string) => response(200, { data: {
    clinic_id: "1", clinic_name: "合成甲店", date: "2026-03-04", as_of: "2026-03-06T09:10:00+08:00", historical: true,
    totals: { deposit_received: "50.00", deposit_refunded: "25.00", deposit_net: "25.00",
      treatment_received: "80.00", treatment_refunded: "15.00", treatment_net: "65.00" },
    settled: [{ id: "11", kind: "TREATMENT_PAYMENT", clinic_id: "1", status: "SUCCEEDED", amount: "80.00",
      receipt_at: "2026-03-04T12:00:00+08:00", requested_at: "2026-03-04T11:00:00+08:00",
      cross_day: false, source: { kind: "invoice", id: "37" }, reason: null, retained_amount: null }],
    pending: [{ id: "21", kind: "DEPOSIT_REFUND", clinic_id: "1", status: "PENDING", amount: "50.00",
      claim_id: "12", deposit_id: "7", receipt_at: null, requested_at: null, cross_day: null, source: null,
      reason: "UNCONFIRMED_APPOINTMENT", retained_amount: null }],
    retained: [], refund_due: [],
  } }));
  vi.stubGlobal("fetch", fetcher);
  render(<DailyReconciliation identity={identity} clinicId="" section="/billing" path="/billing/reconciliation" open={open} />);
  expect(screen.queryByRole("option", { name: "合成乙店" })).toBeNull();
  fireEvent.change(screen.getByLabelText("营业日期"), { target: { value: "2026-03-04" } });
  await screen.findByText("发起时间待核实");
  expect(screen.getByText(/历史营业日/)).toBeTruthy();
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("/billing/reconciliation?clinic_id=1&date=2026-03-04");
  expect(screen.getByText("¥65.00")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看主单" }));
  expect(open).toHaveBeenCalledWith("/billing/invoices/37");
  expect(screen.queryByRole("button", { name: "查看预约" })).toBeNull();
});

test("a failed permission check clears the previously displayed reconciliation amounts", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", async () => ++attempts === 1 ? response(200, { data: {
    clinic_id: "1", clinic_name: "合成甲店", date: "2026-03-04", as_of: "2026-03-04T09:10:00+08:00", historical: false,
    totals: { deposit_received: "79.00", deposit_refunded: "0.00", deposit_net: "79.00",
      treatment_received: "0.00", treatment_refunded: "0.00", treatment_net: "0.00" },
    settled: [], pending: [], retained: [], refund_due: [],
  } }) : response(403, { error: { code: "PERMISSION_DENIED", message: "当前账号不能查询此门店。" } }));
  render(<DailyReconciliation identity={identity} clinicId="1" section="/billing" path="/billing/reconciliation" open={() => {}} />);
  expect((await screen.findAllByText("¥79.00")).length).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "重新查询" }));
  expect((await screen.findByRole("alert")).textContent).toContain("当前账号不能查询此门店。");
  expect(screen.queryByText("¥79.00")).toBeNull();
});


test("opening a source and returning preserves the selected reconciliation clinic and date", async () => {
  const path = "/billing/reconciliation";
  window.history.replaceState({}, "", path);
  const bothClinics = {...identity, role_clinic_ids: { FRONT_DESK: ["1", "2"] }};
  const fetcher = vi.fn(async (request: string) => response(200, { data: {
    clinic_id: "2", clinic_name: "合成乙店", date: "2026-03-04", as_of: "2026-03-05T09:10:00+08:00",
    historical: true, totals: { deposit_received: "0.00", deposit_refunded: "0.00", deposit_net: "0.00",
      treatment_received: "80.00", treatment_refunded: "0.00", treatment_net: "80.00" },
    settled: [{ id: "11", kind: "TREATMENT_PAYMENT", clinic_id: "2", status: "SUCCEEDED", amount: "80.00",
      receipt_at: "2026-03-04T12:00:00+08:00", requested_at: "2026-03-04T11:00:00+08:00",
      cross_day: false, source: { kind: "invoice", id: "37" }, reason: null, retained_amount: null }],
    pending: [], retained: [], refund_due: [],
  } }));
  vi.stubGlobal("fetch", fetcher);
  const open = (target: string) => window.history.pushState({}, "", target);
  const view = <DailyReconciliation identity={bothClinics} clinicId="" section="/billing" path={path} open={open} />;
  const first = render(view);
  fireEvent.change(screen.getByLabelText("对账门店"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("营业日期"), { target: { value: "2026-03-04" } });
  const query = "?clinic_id=2&date=2026-03-04";
  expect(window.location.search).toBe(query);
  fireEvent.click(await screen.findByRole("button", { name: "查看主单" }));
  expect(window.location.pathname).toBe("/billing/invoices/37");
  first.unmount();
  window.history.back();
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe(path + query));
  render(view);
  expect(screen.getByLabelText<HTMLSelectElement>("对账门店").value).toBe("2");
  expect(screen.getByLabelText<HTMLInputElement>("营业日期").value).toBe("2026-03-04");
  await waitFor(() => expect(fetcher.mock.calls.at(-1)?.[0]).toContain(path + query));
});

test("current refund due renders separately and an authorized supervisor can read the exact payment", async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (path.endsWith("/invoices/37/payments/11")) {
      return response(200, { data: { payment_id: "11", invoice_id: "37", kind: "REFUND", status: "FAILED",
        amount: "8.00", paid_at: null, source_payment_id: "5", adjustment_id: null } });
    }
    return response(200, { data: {
      clinic_id: "1", clinic_name: "合成甲店", date: "2026-03-04", as_of: "2026-03-06T09:10:00+08:00",
      historical: true, totals: { deposit_received: "0.00", deposit_refunded: "0.00", deposit_net: "0.00",
        treatment_received: "0.00", treatment_refunded: "0.00", treatment_net: "0.00" },
      settled: [], pending: [], retained: [],
      refund_due: [
        { id: null, kind: "TREATMENT_REFUND_DUE", clinic_id: "1", status: "DUE", amount: "17.00",
          requested_at: null, receipt_at: null, cross_day: null, reason: null, retained_amount: null,
          source: { kind: "payment", invoice_id: "37", id: "11" } },
        { id: "18", kind: "DEPOSIT_REFUND", clinic_id: "1", status: "FAILED", amount: "50.00",
          requested_at: "2026-03-03T12:00:00+08:00", receipt_at: null, cross_day: true,
          reason: "VISIT_STARTED", retained_amount: null, source: null },
      ],
    } });
  });
  vi.stubGlobal("fetch", fetcher);
  const supervisor = {...identity, capabilities: ["CLINIC_MANAGER"], role_clinic_ids: { CLINIC_MANAGER: ["1"] }};
  render(<DailyReconciliation identity={supervisor} clinicId="1" section="/billing" path="/billing/reconciliation" open={() => {}} />);
  expect(await screen.findByRole("heading", {name: "应退待处理"})).toBeTruthy();
  expect(screen.getByText("¥17.00")).toBeTruthy();
  expect(screen.getByText("开始就诊")).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => path.includes("/payments/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", {name: "核对流水"}));
  expect(await screen.findByText("¥8.00")).toBeTruthy();
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("/invoices/37/payments/11");
  expect(screen.queryByRole("button", {name: "查看主单"})).toBeNull();
});
