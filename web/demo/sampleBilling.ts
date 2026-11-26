import { ApiError } from "../src/shared/api";
import { canWorkAt, hasRole, type StaffIdentity } from "../src/shared/navigation";
import type { Correction, Invoice, Payment } from "../src/features/billing/billingTypes";
import type { Visit } from "../src/features/clinical/clinicalTypes";
import { localDate, localTime } from "../src/features/schedule/types";
import { approvals, clinics, funds, type Appointment, type Clinic, type invoices } from "./fixtures";

type Body = Record<string, unknown>;
type DepositReceipt = {
  appointment_id: string; deposit_id: string; claim_id: string; amount: string; paid_at: string; clinic_id?: string;
};
type Options = {
  bills: typeof invoices;
  appointments: Appointment[];
  id: () => string;
  clockDate: string;
  visit: (id: string) => Visit | undefined;
  doctorId: (appointment: Appointment) => string | undefined;
  bookingDeposits?: () => readonly DepositReceipt[];
  clinicName?: (clinicId: string) => string;
};

type LedgerPayment = Payment & { requested_at: string };
type Ledger = {
  invoiceId: string;
  appointment: Appointment;
  issuedAt: string;
  original: number;
  lines: Invoice["lines"];
  adjustments: Invoice["adjustments"];
  payments: LedgerPayment[];
};
type CorrectionRecord = Omit<Correction, "visit_id" | "allowed_actions">;
type FundSource = { kind: "invoice" | "appointment" | "handover"; id: string } | { kind: "payment"; invoice_id: string; id: string };
type Fund = {
  id: string | null;
  kind: "DEPOSIT_PAYMENT" | "DEPOSIT_REFUND" | "TREATMENT_PAYMENT" | "TREATMENT_REFUND" | "TREATMENT_REFUND_DUE";
  status: string;
  amount: string;
  clinic_id: string;
  requested_at: string | null;
  receipt_at: string | null;
  cross_day: boolean | null;
  reason: string | null;
  retained_amount: string | null;
  source: FundSource | null;
  claim_id?: string;
  deposit_id?: string;
  source_payment_id?: string;
};

const front = "FRONT_DESK";
const dentist = "DENTIST";
const manager = "CLINIC_MANAGER";
const billingRoles = [front, dentist, manager];
const at = (day: string, time: string) => day + "T" + time + ":00+08:00";
const cents = (amount: number | string) => Math.round(Number(amount) * 100);
const money = (amount: number) => (amount / 100).toFixed(2);

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, { code, message });
}

function deny(): never {
  return fail(403, "PERMISSION_DENIED", "当前样例身份无权办理此项操作。");
}

function missing(): never {
  return fail(404, "NOT_FOUND", "未找到对应的样例结算记录。");
}

function invalid(message = "请填写有效的结算金额。"): never {
  return fail(400, "VALIDATION_ERROR", message);
}

function inputMoney(value: unknown, signed = false) {
  if (typeof value !== "number" && typeof value !== "string") invalid();
  const text = String(value).trim();
  if (!/^[+-]?(?:\d{1,12}(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) invalid();
  const amount = cents(text);
  if (!signed && amount <= 0) invalid();
  return amount;
}

function requiredText(value: unknown) {
  if (typeof value !== "string" || !value.trim()) invalid("请填写更正说明和原因。");
  return value.trim();
}

function totals(row: Ledger) {
  const sum = (kind: string, status: string) => row.payments.reduce(
    (amount, payment) => payment.kind === kind && payment.status === status ? amount + cents(payment.amount) : amount, 0,
  );
  const received = sum("PAYMENT", "SUCCEEDED");
  const refunded = sum("REFUND", "SUCCEEDED");
  const accrued = row.original + row.adjustments.reduce((amount, item) => amount + cents(item.signed_amount), 0);
  const net = received - refunded;
  return {
    accrued, received, refunded, net,
    outstanding: Math.max(0, accrued - net),
    refundDue: Math.max(0, net - accrued),
    pendingCollection: sum("PAYMENT", "PENDING"),
    pendingRefund: sum("REFUND", "PENDING"),
  };
}

function publicPayment({ requested_at, ...payment }: LedgerPayment): Payment {
  return payment;
}

export function createSampleBilling({ bills, appointments, id, clockDate, visit, doctorId, bookingDeposits,
  clinicName = clinicId => clinics[clinicId as Clinic] ?? clinicId }: Options) {
  const ledgers = new Map<string, Ledger>();
  const corrections = new Map<string, CorrectionRecord>();
  const actions = new Map<string, { signature: string; result: string }>();
  const now = () => at(clockDate, localTime(new Date().toISOString()));
  const dayOf = (value: string) => localDate(value);
  const visitOf = (row: Ledger) => visit(row.appointment.id);
  const visitId = (row: Ledger) => visitOf(row)?.visit_id ?? row.appointment.id;
  const ownsVisit = (actor: StaffIdentity, row: Ledger) =>
    canWorkAt(actor, dentist, row.appointment.clinic)
    && actor.employee_id === (visitOf(row)?.main_dentist_id ?? doctorId(row.appointment));
  const hasCorrection = (row: Ledger) => [...corrections.values()].some(item => item.invoice_id === row.invoiceId);
  const mayRead = (actor: StaffIdentity, row: Ledger) =>
    canWorkAt(actor, front, row.appointment.clinic) || ownsVisit(actor, row)
    || (canWorkAt(actor, manager, row.appointment.clinic) && hasCorrection(row));

  function clerkOnly(actor: StaffIdentity, row: Appointment) {
    if (!canWorkAt(actor, front, row.clinic)) deny();
  }

  function sync(row: Ledger) {
    const balance = totals(row);
    const status = balance.pendingRefund ? "退款处理中" : balance.refundDue ? "待退款" : !balance.outstanding ? "已结清"
      : balance.net > 0 ? "部分收款" : "待收款";
    bills[row.invoiceId] = {
      status, due: balance.accrued / 100, received: balance.received / 100, refunded: balance.refunded / 100,
      outstanding: balance.outstanding / 100, pendingRefund: balance.pendingRefund / 100,
    };
  }

  for (const appointment of appointments) {
    const invoiceId = appointment.invoice;
    const bill = invoiceId && bills[invoiceId];
    if (!bill || !invoiceId) continue;
    const issuedAt = at(appointment.date, appointment.time);
    const payments: LedgerPayment[] = [];
    const seedAdjustments: Invoice["adjustments"] = [];
    for (const entry of approvals.filter(item => item.appointment === appointment.id)) {
      const status = entry.status === "已入账" ? "APPLIED" : entry.status === "已退回" ? "REJECTED" : "PENDING";
      const proposed_amount = money(cents(entry.amount));
      const timestamp = at(appointment.date, "09:15");
      corrections.set(entry.id, {
        correction_id: entry.id, invoice_id: invoiceId, clinic_id: appointment.clinic, status,
        requested_at: timestamp, proposed_amount, reason: entry.reason,
        ...(status === "APPLIED" ? {
          approval: { decision: "APPROVED", reviewer_id: appointment.clinic === "central" ? "5" : "15",
            decided_at: timestamp, approved_signed_amount: proposed_amount },
        } : {}),
      });
      if (status === "APPLIED") seedAdjustments.push({
        adjustment_id: "ADJ-" + entry.id, correction_id: entry.id, signed_amount: proposed_amount,
      });
    }
    const original = cents(bill.due) - seedAdjustments.reduce((sum, entry) => sum + cents(entry.signed_amount), 0);
    const sourceId = invoiceId + "-P1";
    for (const [kind, status, amount, suffix, fixtureKind] of [
      ["PAYMENT", "SUCCEEDED", bill.received, "-P1", "received"],
      ["PAYMENT", "PENDING", funds.find(entry => entry.id === invoiceId && entry.kind === "pending")?.value ?? 0, "-P2", "pending"],
      ["REFUND", "SUCCEEDED", bill.refunded, "-R1", "refund"],
      ["REFUND", "PENDING", bill.pendingRefund ?? 0, "-R2", "pending"],
    ] as const) {
      if (amount <= 0) continue;
      const fixture = funds.find(entry => entry.type === "treatment" && entry.id === invoiceId && entry.kind === fixtureKind);
      const timestamp = fixture ? at(fixture.date, fixture.time) : issuedAt;
      payments.push({
        payment_id: invoiceId + suffix, kind, status, amount: money(cents(amount)), requested_at: timestamp,
        ...(status === "SUCCEEDED" ? { paid_at: timestamp } : {}),
        ...(kind === "REFUND" ? { source_payment_id: sourceId } : {}),
      });
    }
    const lines = [{ line_id: invoiceId + "-L1", treatment_name: appointment.service, unit: "次", units: "1.000",
      unit_price: money(original), subtotal: money(original) }];
    ledgers.set(invoiceId, { invoiceId, appointment, issuedAt, original, lines, adjustments: seedAdjustments, payments });
  }

  function invoiceView(actor: StaffIdentity, row: Ledger): Invoice {
    const balance = totals(row);
    const allowed_actions: string[] = [];
    const result: Invoice = {
      invoice_id: row.invoiceId, invoice_no: row.invoiceId, visit_id: visitId(row),
      appointment_no: row.appointment.id, clinic_id: row.appointment.clinic, issued_at: row.issuedAt,
      clinic_name: clinicName(row.appointment.clinic), ended_at: visitOf(row)?.ended_at,
      status: !balance.outstanding ? "SETTLED" : balance.net > 0 ? "PART_PAID" : "ISSUED",
      original_total: money(row.original), accrued: money(balance.accrued),
      lines: row.lines, adjustments: row.adjustments, allowed_actions,
    };
    if (canWorkAt(actor, front, row.appointment.clinic)) {
      const bookingDeposit = bookingDeposits?.().find(receipt => receipt.appointment_id === row.appointment.id);
      const refund = visitOf(row)?.refund;
      const seededRefund = funds.find(entry => entry.type === "deposit" && entry.kind === "refund" && entry.id === row.appointment.id);
      Object.assign(result, {
        patient_display: {name:row.appointment.patient, phone_tail:("0000000" + row.appointment.patientId.padStart(4,"0")).slice(-4)},
        net_received: money(balance.net), outstanding: money(balance.outstanding), refund_due: money(balance.refundDue),
        pending_collection: money(balance.pendingCollection), pending_refund: money(balance.pendingRefund),
        payments: row.payments.map(publicPayment),
        deposit: { status: "PAID", amount: bookingDeposit?.amount ?? "50.00" },
        deposit_refund: refund ?? (seededRefund && { status: "SUCCEEDED", amount: money(cents(seededRefund.value)) }),
      });
      if (balance.outstanding > balance.pendingCollection) allowed_actions.push("collect");
      if (balance.refundDue > balance.pendingRefund) allowed_actions.push("refund");
    }
    if (ownsVisit(actor, row)) allowed_actions.push("request_correction");
    return result;
  }

  function issue(actor: StaffIdentity, target: string) {
    const current = visit(target);
    const appointment = current && appointments.find(item => item.id === current.appointment_id);
    if (!current || !appointment) missing();
    clerkOnly(actor, appointment);
    if (!current.ended_at || !["COMPLETED", "TERMINATED"].includes(current.status)) {
      fail(409, "INVALID_TRANSITION", "就诊结束后才能开立主单。");
    }
    const existing = appointment.invoice && ledgers.get(appointment.invoice);
    if (existing) return invoiceView(actor, existing);
    if (current.status === "COMPLETED" && !current.treatment_items.length
        || current.treatment_items.some(item => !item.name)) {
      fail(409, "EVIDENCE_REQUIRED", "缺少实际治疗计价快照，请由负责牙医核对。");
    }
    const lines = current.treatment_items.map(item => ({
      line_id: id(), treatment_name: item.name, unit: item.unit, units: item.units,
      unit_price: money(cents(item.unit_price)), subtotal: money(cents(item.amount)),
    }));
    const original = lines.reduce((amount, line) => amount + cents(line.subtotal), 0);
    if (original > 99_999_999_999_999) fail(409, "EVIDENCE_REQUIRED", "主单原始金额超出计费精度。");
    const invoiceId = "ADC-DEMO-INV-" + id();
    const row: Ledger = { invoiceId, appointment, issuedAt: now(), original, lines, adjustments: [], payments: [] };
    ledgers.set(invoiceId, row);
    appointment.invoice = invoiceId;
    sync(row);
    return invoiceView(actor, row);
  }

  function paymentFor(row: Ledger, paymentId: string) {
    const payment = row.payments.find(item => item.payment_id === paymentId);
    if (!payment) missing();
    return payment;
  }

  function actionKey(actor: StaffIdentity, route: string, key: string) {
    return JSON.stringify([actor.account_id, route, key]);
  }

  function once(actor: StaffIdentity, route: string, key: string | undefined, fields: unknown, execute: () => string) {
    if (!key) return execute();
    const scope = actionKey(actor, route, key);
    const signature = JSON.stringify(fields);
    const prior = actions.get(scope);
    if (prior) {
      if (prior.signature !== signature) fail(409, "OPERATION_KEY_CONFLICT", "该操作结果已登记，请查询原操作。");
      return prior.result;
    }
    const result = execute();
    actions.set(scope, { signature, result });
    return result;
  }

  function validateRefund(row: Ledger, source: LedgerPayment, amount: number) {
    const used = row.payments.filter(item => item.source_payment_id === source.payment_id && item.status !== "FAILED")
      .reduce((sum, item) => sum + cents(item.amount), 0);
    const balance = totals(row);
    if (source.kind !== "PAYMENT" || source.status !== "SUCCEEDED"
        || amount > cents(source.amount) - used || amount > balance.refundDue - balance.pendingRefund) {
      fail(409, "REFUND_LIMIT_EXCEEDED", "退款须关联同一主单的原收款，并符合剩余应退及原付款限额。");
    }
  }

  function recordPayment(actor: StaffIdentity, row: Ledger, route: string, key: string | undefined, collect: boolean, body: Body) {
    const amount = inputMoney(body.amount);
    const source = collect ? undefined : String(body.source_payment_id ?? "");
    const adjustment = !collect && body.adjustment_id != null ? String(body.adjustment_id) : undefined;
    const paymentId = once(actor, route, key, [amount, source, adjustment], () => {
      if (source !== undefined) {
        validateRefund(row, paymentFor(row, source), amount);
        if (adjustment !== undefined) {
          const entry = row.adjustments.find(item => item.adjustment_id === adjustment);
          if (!entry) missing();
          if (cents(entry.signed_amount) >= 0) fail(409, "REFUND_LIMIT_EXCEEDED", "退款关联的获批差额须为减额。");
        }
      } else {
        const balance = totals(row);
        if (amount > balance.outstanding - balance.pendingCollection) {
          fail(409, "PAYMENT_RESULT_CONFLICT", "收款额超过主单当前可收的欠款。");
        }
      }
      const timestamp = now();
      const payment: LedgerPayment = {
        payment_id: id(), kind: collect ? "PAYMENT" : "REFUND", amount: money(amount), status: "SUCCEEDED",
        paid_at: timestamp, requested_at: timestamp,
        ...(source !== undefined ? { source_payment_id: source } : {}),
        ...(adjustment !== undefined ? { adjustment_id: adjustment } : {}),
      };
      row.payments.push(payment);
      sync(row);
      return payment.payment_id;
    });
    return { payment: publicPayment(paymentFor(row, paymentId)), invoice: invoiceView(actor, row) };
  }

  function correctionView(actor: StaffIdentity, entry: CorrectionRecord, row: Ledger): Correction {
    const { reason, summary, approval, ...record } = entry;
    const supervisor = canWorkAt(actor, manager, row.appointment.clinic);
    const clinical = supervisor || ownsVisit(actor, row);
    const allowed_actions = [];
    if (supervisor && entry.status === "PENDING") allowed_actions.push("decide");
    if (canWorkAt(actor, front, row.appointment.clinic) && entry.status === "APPROVED") allowed_actions.push("apply");
    return {
      ...record, visit_id: visitId(row), allowed_actions,
      ...(clinical ? { reason, summary } : {}),
      ...(approval ? { approval: clinical ? approval : { ...approval, reason: undefined } } : {}),
    };
  }

  function requestCorrection(actor: StaffIdentity, target: string, route: string, key: string | undefined, body: Body) {
    const current = visit(target);
    const row = ledgers.get(String(body.invoice_id ?? ""));
    if (!current || !row || row.appointment.id !== current.appointment_id) missing();
    if (!ownsVisit(actor, row)) deny();
    const proposed = body.proposed_changes as Body | undefined;
    const reason = requiredText(body.reason);
    const summary = requiredText(proposed?.summary);
    const amount = inputMoney(proposed?.signed_amount, true);
    const correctionId = once(actor, route, key, [row.invoiceId, reason, summary, amount], () => {
      const correction_id = id();
      corrections.set(correction_id, {
        correction_id, invoice_id: row.invoiceId, clinic_id: row.appointment.clinic, reason, summary,
        status: "PENDING", requested_at: now(), proposed_amount: money(amount),
      });
      return correction_id;
    });
    return correctionView(actor, corrections.get(correctionId)!, row);
  }

  function decideCorrection(actor: StaffIdentity, row: Ledger, entry: CorrectionRecord, route: string, key: string | undefined, body: Body) {
    if (!canWorkAt(actor, manager, row.appointment.clinic)) deny();
    const decision = body.decision;
    if (decision !== "APPROVED" && decision !== "REJECTED") invalid("请选择有效的审批结论。");
    const reason = requiredText(body.reason);
    const amount = decision === "APPROVED" ? inputMoney(body.approved_signed_amount ?? entry.proposed_amount, true) : null;
    once(actor, route, key, [decision, reason, amount], () => {
      if (entry.status !== "PENDING") fail(409, "INVALID_TRANSITION", "该更正已有审批结果。");
      if (amount !== null && totals(row).accrued + amount < 0) {
        fail(409, "VALIDATION_ERROR", "获批差额不能使主单应计低于零。");
      }
      entry.status = decision;
      entry.approval = {
        decision, reviewer_id: actor.employee_id, decided_at: now(), reason,
        ...(amount !== null ? { approved_signed_amount: money(amount) } : {}),
      };
      return entry.correction_id;
    });
    return correctionView(actor, entry, row);
  }

  function applyCorrection(actor: StaffIdentity, row: Ledger, entry: CorrectionRecord, invoice: unknown) {
    clerkOnly(actor, row.appointment);
    if (invoice !== row.invoiceId) missing();
    const previous = row.adjustments.find(item => item.correction_id === entry.correction_id);
    if (previous) return { ...previous, invoice_id: row.invoiceId };
    if (entry.status !== "APPROVED" || entry.approval?.approved_signed_amount === undefined) {
      fail(409, "INVALID_TRANSITION", "仅已获批的同次更正可入账。");
    }
    const amount = entry.approval.approved_signed_amount;
    if (totals(row).accrued + cents(amount) < 0) fail(409, "PAYMENT_RESULT_CONFLICT", "应计已变，请重新核对获批差额。");
    const adjustment = { adjustment_id: id(), correction_id: entry.correction_id, signed_amount: amount };
    row.adjustments.push(adjustment);
    entry.status = "APPLIED";
    sync(row);
    return { ...adjustment, invoice_id: row.invoiceId };
  }

  function reconciliation(search: URLSearchParams, actor: StaffIdentity) {
    const clinic = search.get("clinic_id");
    const date = search.get("date");
    if (!clinic || !Object.hasOwn(clinics, clinic) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(at(date, "12:00"))) || dayOf(at(date, "12:00")) !== date) {
      invalid("请选择有效的营业日期和门店。");
    }
    if (!hasRole(actor, [front, manager], clinic)) deny();
    const as_of = at(clockDate, "23:59");
    const settled: Fund[] = [];
    const pending: Fund[] = [];
    const retained: Fund[] = [];
    const refund_due: Fund[] = [];
    const fundsForDay = {
      DEPOSIT_PAYMENT: 0, DEPOSIT_REFUND: 0, TREATMENT_PAYMENT: 0, TREATMENT_REFUND: 0,
    };
    type FundInput = Omit<Fund, "cross_day" | "clinic_id" | "reason" | "retained_amount"> &
      Partial<Pick<Fund, "reason" | "retained_amount">>;

    function add(entry: FundInput) {
      const originDay = entry.requested_at ? dayOf(entry.requested_at) : null;
      if (originDay && originDay > clockDate) return;
      const fund: Fund = { clinic_id: clinic!, cross_day: originDay ? originDay < clockDate : null,
        reason: null, retained_amount: null, ...entry };
      if (fund.status === "DUE" || fund.status === "FAILED") refund_due.push(fund);
      else if (fund.status === "PENDING") pending.push(fund);
      else if (fund.status === "RETAINED" && originDay === date) retained.push(fund);
      else if (fund.receipt_at && dayOf(fund.receipt_at) === date && fund.kind !== "TREATMENT_REFUND_DUE") {
        settled.push(fund);
        fundsForDay[fund.kind] += cents(fund.amount);
      }
    }

    for (const fixture of funds.filter(entry => entry.clinic === clinic && entry.type === "deposit")) {
      const timestamp = at(fixture.date, fixture.time);
      const refund = fixture.kind === "refund";
      add({
        id: fixture.id + (refund ? "-REFUND" : "-DEPOSIT"), kind: refund ? "DEPOSIT_REFUND" : "DEPOSIT_PAYMENT",
        status: refund ? "SUCCEEDED" : "PAID", amount: money(cents(fixture.value)),
        requested_at: timestamp, receipt_at: timestamp,
        reason: refund ? "VISIT_STARTED" : null, source: { kind: "appointment", id: fixture.id },
      });
    }

    const deposits = bookingDeposits?.() ?? [];
    for (const receipt of deposits) {
      const appointment = appointments.find(row => row.id === receipt.appointment_id);
      if (!appointment || (receipt.clinic_id ?? appointment.clinic) !== clinic) continue;
      add({
        id: receipt.deposit_id, kind: "DEPOSIT_PAYMENT", amount: receipt.amount, status: "PAID",
        requested_at: receipt.paid_at, receipt_at: receipt.paid_at, claim_id: receipt.claim_id,
        source: { kind: appointment.clinic === clinic ? "appointment" : "handover", id: receipt.appointment_id },
      });
    }
    for (const appointment of appointments.filter(row => row.clinic === clinic)) {
      if (funds.some(entry => entry.type === "deposit" && entry.kind === "refund" && entry.id === appointment.id)) continue;
      const current = visit(appointment.id);
      const refund = current?.refund;
      if (!current || !refund) continue;
      const deposit = deposits.find(entry => entry.appointment_id === appointment.id);
      add({
        id: refund.refund_id, kind: "DEPOSIT_REFUND", amount: refund.amount, status: refund.status,
        requested_at: current.started_at, receipt_at: refund.status === "SUCCEEDED" ? current.started_at : null,
        claim_id: deposit?.claim_id, deposit_id: deposit?.deposit_id, reason: "VISIT_STARTED",
        source: { kind: "appointment", id: appointment.id },
      });
    }

    const clerk = canWorkAt(actor, front, clinic);
    for (const row of ledgers.values()) {
      if (row.appointment.clinic !== clinic || dayOf(row.issuedAt) > clockDate) continue;
      const viewEvidence = clerk || hasCorrection(row);
      const invoiceSource = { kind: "invoice", id: row.invoiceId } as const;
      for (const payment of row.payments) {
        if (payment.status !== "PENDING" && payment.status !== "SUCCEEDED") continue;
        add({
          id: payment.payment_id, kind: payment.kind === "PAYMENT" ? "TREATMENT_PAYMENT" : "TREATMENT_REFUND",
          status: payment.status, amount: payment.amount,
          requested_at: payment.requested_at, receipt_at: payment.paid_at ?? null,
          source_payment_id: viewEvidence ? payment.source_payment_id : undefined,
          source: clerk ? invoiceSource : viewEvidence ? {
            kind: "payment", invoice_id: row.invoiceId, id: payment.payment_id,
          } : null,
        });
      }
      const balance = totals(row);
      const remaining = balance.refundDue - balance.pendingRefund;
      if (remaining > 0) add({
        id: null, kind: "TREATMENT_REFUND_DUE", status: "DUE", amount: money(remaining),
        requested_at: null, receipt_at: null, source: viewEvidence ? invoiceSource : null,
      });
    }

    return {
      clinic_id: clinic, clinic_name: clinicName(clinic), date, as_of, historical: date < clockDate,
      totals: {
        deposit_received: money(fundsForDay.DEPOSIT_PAYMENT),
        deposit_refunded: money(fundsForDay.DEPOSIT_REFUND),
        deposit_net: money(fundsForDay.DEPOSIT_PAYMENT - fundsForDay.DEPOSIT_REFUND),
        treatment_received: money(fundsForDay.TREATMENT_PAYMENT),
        treatment_refunded: money(fundsForDay.TREATMENT_REFUND),
        treatment_net: money(fundsForDay.TREATMENT_PAYMENT - fundsForDay.TREATMENT_REFUND),
      },
      settled: settled.sort((a, b) => Date.parse(a.receipt_at!) - Date.parse(b.receipt_at!)),
      pending: pending.sort((a, b) => Date.parse(a.requested_at!) - Date.parse(b.requested_at!)),
      retained, refund_due,
    };
  }

  function dispatch(route: string, search: URLSearchParams, method: string, body: Body, key: string | undefined, actor: StaffIdentity): unknown {
    if (method === "GET" && route === "/billing/reconciliation") return reconciliation(search, actor);
    if (method === "GET" && route === "/corrections") {
      if (!hasRole(actor, billingRoles, "")) deny();
      const status = search.get("status");
      const items = [...corrections.values()].reverse().flatMap(entry => {
        const row = ledgers.get(entry.invoice_id);
        if (!row || !mayRead(actor, row) || (status && status !== entry.status)) return [];
        return [correctionView(actor, entry, row)];
      });
      return { items, next_cursor: null };
    }

    const visitRoute = route.match(/^\/visits\/([^/]+)\/(invoice|corrections)$/);
    if (method === "POST" && visitRoute) {
      const [, target, action] = visitRoute;
      return action === "invoice" ? issue(actor, target) : requestCorrection(actor, target, route, key, body);
    }
    const correctionRoute = route.match(/^\/corrections\/([^/]+)\/(decision|apply)$/);
    if (method === "POST" && correctionRoute) {
      const [, correctionId, action] = correctionRoute;
      const entry = corrections.get(correctionId);
      const row = entry && ledgers.get(entry.invoice_id);
      if (!entry || !row) missing();
      return action === "decision" ? decideCorrection(actor, row, entry, route, key, body)
        : applyCorrection(actor, row, entry, body.invoice_id);
    }

    const invoiceRoute = route.match(/^\/invoices\/([^/]+)(?:\/(payments|refunds)(?:\/([^/]+)(\/retry)?)?)?$/);
    if (!invoiceRoute) return;
    const [, invoiceId, kind, paymentId, retry] = invoiceRoute;
    const row = ledgers.get(invoiceId);
    if (!row) missing();
    if (!mayRead(actor, row)) deny();
    if (method === "GET" && !kind) return invoiceView(actor, row);
    if (method === "GET" && kind === "payments" && paymentId && paymentId !== "by-action" && !retry) {
      if (!canWorkAt(actor, front, row.appointment.clinic)
          && !(canWorkAt(actor, manager, row.appointment.clinic) && hasCorrection(row))) deny();
      return publicPayment(paymentFor(row, paymentId));
    }
    if (kind) clerkOnly(actor, row.appointment);
    if (method === "GET" && paymentId === "by-action" && !retry) {
      const scope = key && actionKey(actor, "/invoices/" + invoiceId + "/" + kind, key);
      const prior = scope ? actions.get(scope) : undefined;
      if (!prior) missing();
      return { payment: publicPayment(paymentFor(row, prior.result)), invoice: invoiceView(actor, row) };
    }
    if (method === "POST" && kind && !paymentId) return recordPayment(actor, row, route, key, kind === "payments", body);
    if (method === "POST" && kind === "refunds" && retry) {
      const payment = paymentFor(row, paymentId);
      if (payment.kind !== "REFUND") missing();
      if (payment.status === "FAILED") {
        validateRefund(row, paymentFor(row, payment.source_payment_id!), cents(payment.amount));
        payment.status = "SUCCEEDED";
        payment.paid_at = now();
        sync(row);
      }
      return { payment: publicPayment(payment), invoice: invoiceView(actor, row) };
    }
  }

  return { dispatch };
}
