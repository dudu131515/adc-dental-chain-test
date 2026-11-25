const { request } = require("../../services/api");
const { ensureSession } = require("../../services/session");
const { localDate, query } = require("../../services/booking");

Page({
  data: { clinics: [], treatments: [], clinicIndex: 0, treatmentIndex: 0, date: localDate(), loading: true },

  onLoad(params) {
    this.requestedClinic = params.clinic_id;
  },

  async onShow() {
    this.setData({ loading: true, error: "" });
    try {
      const identity = await ensureSession();
      this.setData({ profileRequired: Boolean(identity.profile_required) });
      if (identity.profile_required) return;
      const [clinics, treatments] = await Promise.all([request("/clinics"), request("/catalog/treatments")]);
      const clinicIndex = this.requestedClinic
        ? clinics.items.findIndex(item => item.clinic_id === this.requestedClinic)
        : Math.min(this.data.clinicIndex, Math.max(0, clinics.items.length - 1));
      this.requestedClinic = undefined;
      this.setData({
        clinics: clinics.items, treatments: treatments.items, clinicIndex,
        error: clinicIndex < 0 ? "此门店当前不可预约，请重新选择。" : "",
        treatmentIndex: Math.min(this.data.treatmentIndex, Math.max(0, treatments.items.length - 1)),
      });
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  chooseClinic(event) { this.setData({ clinicIndex: Number(event.detail.value), error: "" }); },
  chooseTreatment(event) { this.setData({ treatmentIndex: Number(event.detail.value) }); },
  chooseDate(event) { this.setData({ date: event.detail.value }); },
  profile() { wx.navigateTo({ url: "/pages/profile/index" }); },

  continue() {
    const { clinics, treatments, clinicIndex, treatmentIndex, date } = this.data;
    const clinic = clinics[clinicIndex], treatment = treatments[treatmentIndex];
    if (!clinic || !treatment) return;
    if (!treatment.default_slot_minutes) {
      this.setData({ error: "本项目需先由牙医估时，再由门店前台办理。" });
      return;
    }
    wx.navigateTo({
      url: "/pages/time-selection/index?" + query({
        clinic_id: clinic.clinic_id, treatment_type_id: treatment.treatment_type_id, date,
      }),
    });
  },
});
