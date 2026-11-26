const { request } = require("../../services/api");
const { appointmentReceipts, localDate, query, states } = require("../../services/booking");
const patient = require("../../services/patient");
const recovery = require("../../services/deposit-recovery");

async function recoveredReceipt(identity, entry, confirmed) {
  let hold, payment;
  try {
    hold = await recovery.lookup(entry);
    if (confirmed.has(hold.payment.deposit_id)) {
      recovery.forget(identity, entry.key);
      return null;
    }
    payment = await request("/deposit-payments/" + hold.payment.deposit_id);
  } catch (failure) {
    if (failure.status !== 404) throw failure;
    if (hold) return null;
    return { depositId: entry.key, resumeKey: entry.key, treatmentName: "临时占位", paymentLabel: "待核对" };
  }
  const appointmentId = payment.appointment_id;
  const active = hold.status === "HOLD" && payment.claim_status === "HOLD";
  if (!active && !appointmentId && payment.status === "NOT_STARTED") {
    recovery.forget(identity, entry.key);
    return null;
  }
  return {
    depositId: payment.deposit_id, appointmentId,
    resumeKey: !appointmentId && active ? entry.key : undefined,
    treatmentName: appointmentId ? "预约金" : active ? "临时占位" : "预约未确认",
    date: localDate(hold.start_at), amount: payment.amount,
    paymentLabel: states[payment.status] || payment.status,
    refundLabel: payment.refund && (states[payment.refund.status] || payment.refund.status),
    refundAmount: payment.refund?.amount,
  };
}

Page({
  data: { loading: true, entries: [] },
  onShow() {
    return patient.loadPatient(this, async identity => {
      const entries = appointmentReceipts((await request("/appointments")).items);
      const confirmed = new Set(entries.map(entry => entry.depositId));
      const recovered = await Promise.all(recovery.attempts(identity).map(entry => recoveredReceipt(identity, entry, confirmed)));
      entries.push(...recovered.filter(Boolean));
      entries.sort((left, right) => (right.date || "").localeCompare(left.date || ""));
      return { entries };
    });
  },
  open(event) {
    const { id, resume } = event.currentTarget.dataset;
    if (id) patient.openAppointment(id);
    else if (resume) wx.navigateTo({ url: "/pages/booking-confirm/index?" + query({ resume }) });
    else this.onShow();
  },
  profile: patient.profile, book: patient.book, invoices: patient.invoices,
});
