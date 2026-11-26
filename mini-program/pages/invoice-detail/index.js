const { request } = require("../../services/api");
const { localDate, localTime } = require("../../services/booking");
const patient = require("../../services/patient");

function displayFund(row, key) {
  const label = row.kind === "PAYMENT" ? "诊疗收款" : row.status === "PENDING" ? "退款处理中" : "诊疗退款";
  return {...row, key, label, when: row.receipt_at ? localDate(row.receipt_at) + " " + localTime(row.receipt_at) : ""};
}

Page({
  data: { loading: true, invoice: null },
  onLoad(params) { this.invoiceId = params.id; },
  onShow() {
    this.setData({invoice: null});
    return patient.loadPatient(this, async () => {
      const invoice = await request("/patients/me/invoices/" + encodeURIComponent(this.invoiceId));
      return {invoice: {
        ...invoice,
        statusLabel: patient.invoiceStatus(invoice.status),
        lines: invoice.lines.map((row, key) => ({...row, key})),
        adjustments: invoice.adjustments.map((row, key) => ({...row, key})),
        funds: invoice.funds.map(displayFund),
      }};
    });
  },
  profile: patient.profile,
});
