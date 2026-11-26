const { request } = require("../../services/api");
const { appointmentSummary, localDate, localTime, query, states } = require("../../services/booking");
const { openInvoice } = require("../../services/patient");

Page({
  data: { loading: true, invoiceId: "", invoiceError: "" },
  onLoad(params) { this.id = params.id; },

  async onShow() {
    const version = (this.loadVersion || 0) + 1;
    this.loadVersion = version;
    this.setData({ loading: true, error: "", invoiceId: "", invoiceError: "" });
    try {
      const row = await request("/appointments/" + encodeURIComponent(this.id));
      if (version !== this.loadVersion) return;
      const actions = row.allowed_actions || [];
      this.setData({
        appointment: appointmentSummary(row),
        changeDeadline: row.change_deadline_at ? localDate(row.change_deadline_at) + " " + localTime(row.change_deadline_at) : "",
        calendarIssue: row.calendar_issue,
        refund: row.refund,
        refundLabel: row.refund ? states[row.refund.status] : "",
        deposit: row.deposit, depositLabel: row.deposit ? states[row.deposit.status] : "",
        canReschedule: actions.includes("reschedule"),
        canCancel: actions.includes("cancel"),
        contactClinic: actions.includes("contact_clinic"),
      });
      if (row.status === "COMPLETED") await this.loadInvoice();
    } catch (failure) {
      if (version === this.loadVersion) this.setData({ error: failure.message });
    } finally {
      if (version === this.loadVersion) this.setData({ loading: false });
    }
  },

  async loadInvoice() {
    const version = this.loadVersion;
    this.setData({invoiceError: ""});
    try {
      const data = await request("/patients/me/invoices?" + query({appointment_id: this.id, limit: 1}));
      if (version === this.loadVersion) this.setData({invoiceId: data.items[0]?.invoice_id || ""});
    } catch (failure) {
      if (version === this.loadVersion) this.setData({invoiceError: failure.message});
    }
  },

  openInvoice() { if (this.data.invoiceId) openInvoice(this.data.invoiceId); },
  call() {
    const phone = this.data.appointment?.clinicPhone;
    if (phone) wx.makePhoneCall({ phoneNumber: String(phone) });
  },
  all() { wx.switchTab({ url: "/pages/appointments/index" }); },
  reschedule() { wx.navigateTo({ url: "/pages/reschedule/index?id=" + encodeURIComponent(this.id) }); },
  cancel() { wx.navigateTo({ url: "/pages/cancel/index?id=" + encodeURIComponent(this.id) }); },
});
