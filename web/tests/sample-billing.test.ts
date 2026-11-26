import { expect, test } from "vitest";
import { createSampleBilling } from "../demo/sampleBilling";
import { createSampleWorkspace } from "../demo/sampleWorkspace";
import { appointments, invoices } from "../demo/fixtures";
import type { BillingEntry, Invoice } from "../src/features/billing/billingTypes";
import type { Visit } from "../src/features/clinical/clinicalTypes";
import type { StaffIdentity } from "../src/shared/navigation";

const clerk: StaffIdentity = {
  account_id: "4", employee_id: "4", category: "staff", clinics: [],
  capabilities: ["FRONT_DESK"], role_clinic_ids: { FRONT_DESK: ["central"] },
};
const dentist: StaffIdentity = {
  ...clerk, account_id: "1", employee_id: "1", capabilities: ["DENTIST"], role_clinic_ids: { DENTIST: ["central"] },
};
const manager: StaffIdentity = {
  ...clerk, account_id: "5", employee_id: "5", capabilities: ["CLINIC_MANAGER"], role_clinic_ids: { CLINIC_MANAGER: ["central"] },
};

function demo() {
  const rows = structuredClone(appointments);
  const bills = structuredClone(invoices);
  const completed: Visit = {
    visit_id: "501", appointment_id: "ADC-DEMO-001", appointment_no: "ADC-DEMO-001", main_dentist_id: "1",
    status: "COMPLETED", started_at: "2026-11-25T08:30:00+08:00", ended_at: "2026-11-25T09:00:00+08:00",
    estimated_amount: "100.00", planned_treatment_type_id: "1",
    refund: { refund_id: "601", amount: "50.00", status: "SUCCEEDED" },
    treatment_items: [{ item_id: "701", treatment_type_id: "1", name: "口腔检查", unit: "次", units: "1.000",
      unit_price: "80.00", amount: "80.00" }],
  };
  let next = 1000;
  const billing = createSampleBilling({
    appointments: rows, bills, clockDate: "2026-11-25", id: () => String(++next),
    visit: value => [completed.visit_id, completed.appointment_id].includes(value) ? completed : undefined,
    doctorId: row => row.doctor === "林明远" ? "1" : undefined,
  });
  return {
    bills, rows,
    get: (route: string, actor = clerk, query = "", key?: string) => billing.dispatch(route, new URLSearchParams(query), "GET", {}, key, actor),
    post: (route: string, fields: Record<string, unknown>, actor = clerk, key?: string) =>
      billing.dispatch(route, new URLSearchParams(), "POST", fields, key, actor),
  };
}

test("simulated settlement copies completed treatment charges and recovers a collection using its action key", () => {
  const { bills, rows, get, post } = demo();
  expect(() => post("/visits/501/invoice", {}, dentist)).toThrow();
  const invoice = post("/visits/501/invoice", {}) as Invoice;
  const base = "/invoices/" + invoice.invoice_id;
  expect(invoice).toMatchObject({
    visit_id: "501", original_total: "80.00", outstanding: "80.00", status: "ISSUED",
    lines: [{ treatment_name: "口腔检查", subtotal: "80.00" }], deposit_refund: { amount: "50.00", status: "SUCCEEDED" },
  });
  expect(rows.find(row => row.id === "ADC-DEMO-001")?.invoice).toBe(invoice.invoice_id);
  expect(post("/visits/501/invoice", {})).toMatchObject({ invoice_id: invoice.invoice_id });
  expect(() => post(base + "/payments", { amount: "80.01" })).toThrow();
  const transaction = post(base + "/payments", { amount: "80.00" }, clerk, "collect-1");
  expect(transaction).toMatchObject({ payment: { amount: "80.00", status: "SUCCEEDED" }, invoice: { outstanding: "0.00" } });
  expect(get(base + "/payments/by-action", clerk, "", "collect-1")).toEqual(transaction);
  expect(post(base + "/payments", { amount: "80.00" }, clerk, "collect-1")).toEqual(transaction);
  expect(() => post(base + "/payments", { amount: "0.01" }, clerk, "collect-1")).toThrow();
  expect(get(base, dentist)).toMatchObject({ allowed_actions: ["request_correction"] });
  expect(get(base, dentist)).not.toHaveProperty("payments");
  expect(bills[invoice.invoice_id]).toMatchObject({ received: 80, outstanding: 0 });
});

test("an approved correction updates the original bill and refunds flow into reconciliation", () => {
  const { bills, get, post } = demo();
  const invoice = post("/visits/501/invoice", {}) as Invoice;
  const base = "/invoices/" + invoice.invoice_id;
  const { payment } = post(base + "/payments", { amount: "80" }) as { payment: { payment_id: string } };
  const { correction_id } = post("/visits/501/corrections", {
    invoice_id: invoice.invoice_id, reason: "计费核对", proposed_changes: { summary: "差额退回", signed_amount: "-20" },
  }, dentist) as { correction_id: string };
  const correction = "/corrections/" + correction_id;
  expect(get("/corrections", manager)).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ correction_id, reason: "计费核对", allowed_actions: ["decide"] })]),
  });
  expect(() => post(correction + "/decision", { decision: "APPROVED", reason: "核对通过" }, clerk)).toThrow();
  post(correction + "/decision", { decision: "APPROVED", reason: "核对通过" }, manager);
  const adjustment = post(correction + "/apply", { invoice_id: invoice.invoice_id }) as { adjustment_id: string };
  expect(get(base)).toMatchObject({ original_total: "80.00", accrued: "60.00", refund_due: "20.00" });
  expect(post(correction + "/apply", { invoice_id: invoice.invoice_id })).toEqual(adjustment);
  expect(() => post(base + "/refunds", { source_payment_id: payment.payment_id, amount: "20.01" })).toThrow();
  const refund = post(base + "/refunds", {
    source_payment_id: payment.payment_id, adjustment_id: adjustment.adjustment_id, amount: "20.00",
  }, clerk, "refund-1");
  expect(get(base + "/refunds/by-action", clerk, "", "refund-1")).toEqual(refund);
  expect(get(base + "/payments/" + payment.payment_id, manager)).toMatchObject({ amount: "80.00" });
  expect(bills[invoice.invoice_id]).toMatchObject({ due: 60, received: 80, refunded: 20, outstanding: 0 });
  expect(get("/billing/reconciliation", clerk, "clinic_id=central&date=2026-11-25")).toMatchObject({
    totals: { treatment_received: "160.00", treatment_refunded: "20.00", treatment_net: "140.00" },
    pending: [expect.objectContaining({ amount: "30.00" })],
    refund_due: [],
    settled: expect.arrayContaining([expect.objectContaining({
      kind: "TREATMENT_REFUND", amount: "20.00", source_payment_id: payment.payment_id,
      source: { kind: "invoice", id: invoice.invoice_id },
    })]),
  });
  expect(() => get("/billing/reconciliation", clerk, "clinic_id=river&date=2026-11-25")).toThrow();
});

test("the shared sample transport links the settlement queue, invoice and patient history", async () => {
  const workspace = createSampleWorkspace();
  const front = workspace.transport("front");
  const queue = "/billing/queue?clinic_id=central";
  const query = { queueSearch: "ADC-DEMO-001" };
  const { items } = await front<{ items: BillingEntry[] }>(queue + "&status=WAITING_INVOICE", query);
  expect(items).toHaveLength(1);
  const entry = items[0];
  expect(entry.appointment_no).toBe("ADC-DEMO-001");

  const path = "/visits/" + entry.visit_id;
  expect(await front<Visit>(path)).toMatchObject({ can_issue_invoice: true, visit_id: entry.visit_id });
  const invoice = await front<Invoice>(path + "/invoice", { method: "POST", body: {}, actionKey: "issue-sample" });
  expect(await front<Invoice>("/invoices/" + invoice.invoice_id)).toMatchObject({
    visit_id: entry.visit_id, original_total: "80.00", outstanding: "80.00",
  });
  expect(await front(queue + "&status=WAITING_PAYMENT", query)).toMatchObject({
    items: [{ visit_id: entry.visit_id, invoice_id: invoice.invoice_id, billing_state: "WAITING_PAYMENT" }],
  });
  expect(await front("/clinics/central/patient-directory/3")).toMatchObject({
    appointments: [expect.objectContaining({
      appointment_id: entry.appointment_no, invoice: expect.objectContaining({
        invoice_id: invoice.invoice_id, invoice_no: invoice.invoice_no, status: "ISSUED",
      }),
    })],
  });
});
