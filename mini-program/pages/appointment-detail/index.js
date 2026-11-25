const { request } = require("../../services/api");
const { appointmentSummary, localDate, localTime, states } = require("../../services/booking");

Page({
  data: { loading: true },
  onLoad(params) { this.id = params.id; },

  async onShow() {
    this.setData({ loading: true, error: "" });
    try {
      const row = await request("/appointments/" + encodeURIComponent(this.id));
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
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  all() { wx.switchTab({ url: "/pages/appointments/index" }); },
  reschedule() { wx.navigateTo({ url: "/pages/reschedule/index?id=" + encodeURIComponent(this.id) }); },
  cancel() { wx.navigateTo({ url: "/pages/cancel/index?id=" + encodeURIComponent(this.id) }); },
});
