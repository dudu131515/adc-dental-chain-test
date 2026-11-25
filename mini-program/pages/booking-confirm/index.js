const { request, resolveUnknown } = require("../../services/api");
const { actionKey, localDate, query, slotLabel, states } = require("../../services/booking");
const { ensureSession } = require("../../services/session");
const recovery = require("../../services/deposit-recovery");

Page({
  data: { seconds: 0, loading: true, pending: false },

  onLoad(params) {
    this.resume = Boolean(params.resume);
    this.key = params.resume || actionKey("hold");
    if (this.resume) return;
    try {
      const fields = ["clinic_id", "dentist_id", "shift_id", "treatment_type_id", "start_at", "end_at"];
      this.params = Object.fromEntries(fields.map(field => [field, decodeURIComponent(params[field] || "")]));
      this.showSlot(decodeURIComponent(params.dentist_name || ""));
    } catch {
      this.params = null;
      this.setData({ loading: false, invalid: true, error: "时段链接不完整，请返回重新选时。" });
    }
  },

  showSlot(dentistName) {
    const { start_at, end_at } = this.params;
    this.setData({ when: slotLabel(start_at, end_at), day: localDate(start_at), dentistName });
  },

  async onShow() {
    if (!this.resume && !this.params) return;
    this.setData({ loading: true, error: "" });
    try {
      const identity = await ensureSession();
      if (identity.profile_required || (this.identity && this.identity.account_id !== identity.account_id)) {
        this.setData({ invalid: true, profile: null, hold: null, payment: null, error: "请从本人预约入口重新办理。" });
        this.params = null;
        this.onUnload();
        return;
      }
      this.identity = identity;
      if (this.resume && !this.params) {
        const entry = recovery.attempts(identity).find(item => item.key === this.key);
        if (!entry) {
          this.setData({ invalid: true, error: "当前账号没有可恢复的预约操作。" });
          return;
        }
        this.params = entry.payload;
        this.showSlot("");
        this.unknown = true;
        this.setData({ unknown: true });
      }
      if (!this.data.clinic || !this.data.treatment) {
        const [clinics, treatments] = await Promise.all([request("/clinics"), request("/catalog/treatments")]);
        this.setData({
          clinic: clinics.items.find(item => item.clinic_id === this.params.clinic_id),
          treatment: treatments.items.find(item => item.treatment_type_id === this.params.treatment_type_id),
        });
      }
      this.setData({ profile: await request("/patients/me") });
      if (this.data.hold && !this.data.pending) {
        await this.checkPayment();
      } else if (!this.data.hold && this.unknown && !this.data.pending) {
        try {
          const hold = await recovery.lookup(this.entry());
          this.unknown = false;
          this.setData({ unknown: false });
          this.showHold(hold);
          if (!hold.appointment_id) await this.checkPayment();
        } catch (failure) {
          if (failure.status !== 404) throw failure;
        }
      }
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  onUnload() { if (this.timer) clearInterval(this.timer); },
  profile() { wx.navigateTo({ url: "/pages/profile/index" }); },
  entry() { return { key: this.key, payload: this.params }; },

  showHold(hold) {
    this.setData({ hold });
    this.expiration = Date.parse(hold.expires_at) - (Date.parse(hold.server_time) - Date.now());
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.count(), 1000);
    this.count();
    this.acceptPayment({ ...hold.payment, claim_status: hold.status, appointment_id: hold.appointment_id });
  },

  count() {
    const seconds = Math.max(0, Math.ceil((this.expiration - Date.now()) / 1000));
    this.setData({ seconds, countdown: Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") });
    if (seconds === 0 && this.timer) clearInterval(this.timer);
  },

  async reserve() {
    if (this.data.pending || this.data.invalid || this.data.hold || !this.params || !this.identity) return;
    this.setData({ pending: true, error: "" });
    let checking = Boolean(this.unknown);
    const entry = this.entry();
    const post = () => {
      checking = false;
      return request("/holds", { method: "POST", actionKey: entry.key, data: entry.payload });
    };
    try {
      recovery.remember(this.identity, entry);
      const hold = checking ? await resolveUnknown(() => recovery.lookup(entry), post) : await post();
      this.unknown = false;
      this.showHold(hold);
    } catch (failure) {
      this.unknown = checking || failure.code === "RESULT_UNKNOWN";
      if (!this.unknown) recovery.forget(this.identity, entry.key);
      this.setData({ error: failure.message });
    } finally {
      this.setData({ pending: false, unknown: Boolean(this.unknown) });
    }
  },

  acceptPayment(payment) {
    this.setData({
      payment, paymentLabel: states[payment.status] || payment.status,
      refundLabel: payment.refund ? states[payment.refund.status] || payment.refund.status : "",
    });
    if (payment.appointment_id) {
      recovery.forget(this.identity, this.key);
      wx.redirectTo({ url: "/pages/appointment-detail/index?id=" + encodeURIComponent(payment.appointment_id) });
    }
  },

  async checkPayment() {
    if (!this.data.hold || this.data.checkingPayment) return;
    this.setData({ checkingPayment: true });
    try {
      const payment = await request("/deposit-payments/" + this.data.hold.payment.deposit_id);
      this.setData({ paymentUnknown: false, error: "" });
      this.acceptPayment(payment);
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ checkingPayment: false });
    }
  },

  async pay() {
    if (this.data.pending || this.data.checkingPayment || this.data.paymentUnknown || !this.data.seconds
        || this.data.payment?.status !== "NOT_STARTED" || this.data.payment.claim_status !== "HOLD") return;
    this.setData({ pending: true, error: "" });
    try {
      this.acceptPayment(await request("/deposit-payments/" + this.data.hold.payment.deposit_id + "/simulate", { method: "POST" }));
    } catch (failure) {
      this.setData({ error: failure.message, paymentUnknown: failure.code === "RESULT_UNKNOWN" });
      if (failure.code === "RESULT_UNKNOWN" || failure.code === "HOLD_EXPIRED") await this.checkPayment();
    } finally {
      this.setData({ pending: false });
    }
  },

  reselect() {
    if (this.resume) {
      wx.redirectTo({ url: "/pages/booking/index?" + query({ clinic_id: this.params.clinic_id }) });
    } else {
      wx.navigateBack();
    }
  },

  async abandon() {
    if (this.data.pending || this.data.checkingPayment || this.data.paymentUnknown
        || this.data.payment?.claim_status !== "HOLD") return;
    this.setData({ pending: true });
    try {
      const released = await request("/holds/" + this.data.hold.claim_id + "/release", { method: "POST" });
      if (released.payment.status === "NOT_STARTED") recovery.forget(this.identity, this.key);
      this.reselect();
    } catch (failure) {
      this.setData({ error: failure.message, paymentUnknown: failure.code === "RESULT_UNKNOWN" });
      await this.checkPayment();
    } finally {
      this.setData({ pending: false });
    }
  },
});
