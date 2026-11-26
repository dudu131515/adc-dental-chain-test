export type Payment = {
  payment_id: string; kind: string; status: string; amount: string; paid_at?: string;
  source_payment_id?: string; adjustment_id?: string; reconciliation_required?: boolean;
};
export type Invoice = {
  invoice_id: string; invoice_no: string; visit_id: string; appointment_no: string; status: string;
  original_total: string; accrued: string; issued_at: string; clinic_id: string;
  net_received?: string; outstanding?: string; refund_due?: string; pending_collection?: string; pending_refund?: string;
  deposit?: { status: string; amount: string }; deposit_refund?: { status: string; amount: string };
  lines: { line_id: string; treatment_name: string; unit: string; units: string; unit_price: string; subtotal: string }[];
  adjustments: { adjustment_id: string; correction_id: string; signed_amount: string }[];
  payments?: Payment[]; allowed_actions: string[];
};
export type Correction = {
  correction_id: string; visit_id: string; invoice_id: string; clinic_id: string; status: string; requested_at: string;
  proposed_amount: string; reason?: string; summary?: string; allowed_actions: string[];
  approval?: { decision: string; reviewer_id: string; decided_at: string; approved_signed_amount?: string; reason?: string };
};
export type BillingEntry = {
  clinic_name: string; patient_display: { name: string; phone_tail: string | null };
  billing_state: "WAITING_INVOICE" | "WAITING_PAYMENT" | "PARTIAL_PAYMENT" | "SETTLED" | "REFUND_DUE" | "REFUND_PENDING";
  outstanding: string | null; refund_remaining: string; pending_refund: string;
  visit_id: string; appointment_no: string; clinic_id: string; ended_at: string; status: string;
  invoice_id: string | null; invoice_no: string | null;
};

export const invoiceStates: Record<string, string> = { ISSUED: "已开单", PART_PAID: "部分收款", SETTLED: "已结清" };
export const correctionStates: Record<string, string> = {
  PENDING: "待审批", APPROVED: "已获批 · 待入账", REJECTED: "已拒绝", APPLIED: "已入账",
};
