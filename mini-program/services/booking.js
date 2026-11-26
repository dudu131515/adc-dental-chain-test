const states = {
  CONFIRMED: "已确认", CHECKED_IN: "已签到", IN_TREATMENT: "就诊中",
  COMPLETED: "已完成", CANCELLED: "已取消", NO_SHOW: "未到诊",
  NOT_STARTED: "待支付", PENDING: "处理中", PAID: "已支付", FAILED: "失败",
  SUCCEEDED: "已退款", RETAINED: "已留存",
};
const weekdays = ["周日","周一","周二","周三","周四","周五","周六"];
function localStamp(value = Date.now()) {
  return new Date(new Date(value).getTime() + 8 * 3600000).toISOString();
}
function localDate(value) { return localStamp(value).slice(0, 10); }
function localTime(value) { return localStamp(value).slice(11, 16); }
function dateParts(value) {
  const stamp = new Date(localStamp(value));
  const day = String(stamp.getUTCDate()).padStart(2, "0");
  const month = stamp.getUTCMonth() + 1;
  return {day, month, dateLabel: month + "月" + Number(day) + "日", weekday: weekdays[stamp.getUTCDay()]};
}
function slotLabel(start, end) { return localDate(start) + " " + localTime(start) + "–" + localTime(end); }
function query(params) {
  return Object.keys(params).map(key => encodeURIComponent(key) + "=" + encodeURIComponent(params[key])).join("&");
}
function actionKey(action) { return action + "-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
function appointmentSummary(row) {
  return {
    ...dateParts(row.start_at), id: row.appointment_id, clinicName: row.clinic.name, address: row.clinic.address,
    clinicPhone: row.clinic.phone || "",
    dentistName: row.dentist.name, treatmentName: row.treatment.name, number: row.appointment_no,
    date: localDate(row.start_at), time: localTime(row.start_at) + "–" + localTime(row.end_at),
    when: slotLabel(row.start_at, row.end_at), status: row.status, statusLabel: states[row.status] || row.status,
  };
}
function groupAppointments(rows, now = Date.now()) {
  const upcoming = [], history = [];
  const today = localDate(now);
  function attending(row) { return row.status === "CHECKED_IN" || row.status === "IN_TREATMENT"; }
  function priority(row) { return attending(row) && localDate(row.start_at) === today ? 0 : 1; }
  for (const row of rows) {
    const active = attending(row) && localDate(row.start_at) === today;
    const booked = ["CONFIRMED","CHECKED_IN","IN_TREATMENT"].includes(row.status) && Date.parse(row.end_at) > now;
    (active || booked ? upcoming : history).push(row);
  }
  upcoming.sort((a,b) => priority(a) - priority(b) || Date.parse(a.start_at) - Date.parse(b.start_at));
  history.sort((a,b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  return {upcoming: upcoming.map(appointmentSummary), history: history.map(appointmentSummary)};
}
function appointmentReceipts(rows) {
  return rows.filter(row => row.deposit).sort((a,b) => Date.parse(b.start_at) - Date.parse(a.start_at)).map(row => ({
    depositId: row.deposit.deposit_id, amount: row.deposit.amount, paymentLabel: states[row.deposit.status] || row.deposit.status,
    appointmentId: row.appointment_id, number: row.appointment_no, clinicName: row.clinic.name,
    date: localDate(row.start_at), treatmentName: row.treatment.name,
    refundLabel: row.refund ? (states[row.refund.status] || row.refund.status) : "",
    refundAmount: row.refund ? row.refund.amount : "", refundId: row.refund ? row.refund.refund_id : "",
  }));
}
module.exports = {states, localDate, localTime, dateParts, slotLabel, query, actionKey, appointmentSummary, groupAppointments, appointmentReceipts};
