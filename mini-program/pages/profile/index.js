const { request } = require("../../services/api");
const { ensureSession, bindProfile, logout } = require("../../services/session");

Page({
  data: { loading: true, pending: false, profile: {} },

  async onLoad() {
    try {
      const user = await ensureSession();
      this.setData({
        firstTime: Boolean(user.profile_required),
        profile: user.profile_required ? {} : await request("/patients/me"),
      });
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  birthDate(event) { this.setData({ "profile.birth_date": event.detail.value }); },

  async save(event) {
    if (this.data.pending) return;
    const fields = event.detail.value;
    const payload = { ...fields, birth_date: this.data.profile.birth_date, email: fields.email || null };
    if (!payload.birth_date) {
      this.setData({ error: "请选择出生日期。" });
      return;
    }
    this.setData({ pending: true, error: "" });
    try {
      if (this.data.firstTime) await bindProfile(payload);
      else await request("/patients/me", { method: "PATCH", data: payload });
      wx.navigateBack();
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ pending: false });
    }
  },

  async leave() {
    try { await logout(); }
    finally { wx.switchTab({ url: "/pages/appointments/index" }); }
  },
});
