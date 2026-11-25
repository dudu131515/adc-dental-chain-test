const { request } = require("../../services/api");
const { actionKey, appointmentSummary } = require("../../services/booking");

Page({
  data: { loading: true, pending: false },

  async onLoad(params) {
    this.path = "/appointments/" + params.id;
    this.key = actionKey("cancel");
    try {
      const original = await request(this.path);
      this.setData({ initial: appointmentSummary(original) });
      this.setData({ quote: await request(this.path + "/cancellation-quote") });
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  async submit(event) {
    if (this.data.pending || !this.data.quote) return;
    this.setData({ pending: true, error: "" });
    const quote = this.data.quote;
    if (!this.payload) this.payload = {
      expected_claim_id: quote.expected_claim_id,
      quoted_refund_amount: quote.refund_amount,
      reason: event.detail.value.reason,
    };
    let checking = Boolean(this.unknown);
    try {
      if (checking) {
        const current = await request(this.path);
        if (current.status === "CANCELLED") {
          wx.navigateBack();
          return;
        }
      }
      checking = false;
      await request(this.path + "/cancel", { method: "POST", actionKey: this.key, data: this.payload });
      wx.navigateBack();
    } catch (failure) {
      this.unknown = checking || failure.code === "RESULT_UNKNOWN";
      if (!this.unknown) this.payload = undefined;
      if (failure.code === "CANCELLATION_QUOTE_CHANGED") {
        this.key = actionKey("cancel");
        this.setData({ "quote.refund_amount": failure.details.refund_amount });
      } else if (failure.code === "CANCELLATION_REVIEW_REQUIRED") {
        this.setData({ quote: null });
      }
      this.setData({ unknown: Boolean(this.unknown), error: failure.message });
    } finally {
      this.setData({ pending: false });
    }
  },
});
