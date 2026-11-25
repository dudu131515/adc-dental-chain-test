const { request } = require("../../services/api");
const { localTime, query } = require("../../services/booking");

Page({
  data: { slots: [], selected: -1, loading: true },

  async onLoad(params) {
    this.params = params;
    this.setData({ date: params.date });
    try {
      const [clinics, treatments] = await Promise.all([request("/clinics"), request("/catalog/treatments")]);
      this.setData({
        clinic: clinics.items.find(item => item.clinic_id === params.clinic_id),
        treatment: treatments.items.find(item => item.treatment_type_id === params.treatment_type_id),
      });
      await this.refresh();
    } catch (failure) {
      this.setData({ loading: false, error: failure.message });
    }
  },

  async refresh() {
    const revision = this.revision = (this.revision || 0) + 1;
    this.setData({ loading: true, selected: -1, error: "", slots: [] });
    try {
      const data = await request("/booking/options?" + query({
        clinic_id: this.params.clinic_id, treatment_type_id: this.params.treatment_type_id, date: this.data.date,
      }));
      if (revision !== this.revision) return;
      this.setData({ slots: data.items.map(row => ({
        ...row, slotKey: row.shift_id + ":" + row.start_at,
        label: localTime(row.start_at) + "–" + localTime(row.end_at),
      })) });
    } catch (failure) {
      if (revision === this.revision) this.setData({ error: failure.message, slots: [] });
    } finally {
      if (revision === this.revision) this.setData({ loading: false });
    }
  },

  chooseDate(event) { this.setData({ date: event.detail.value }); this.refresh(); },
  pick(event) { this.setData({ selected: event.currentTarget.dataset.index }); },
  confirm() {
    const chosen = this.data.slots[this.data.selected];
    if (!chosen) return;
    wx.navigateTo({
      url: "/pages/booking-confirm/index?" + query({
        clinic_id: chosen.clinic_id, dentist_id: chosen.dentist_id, shift_id: chosen.shift_id,
        dentist_name: chosen.dentist_name, treatment_type_id: chosen.treatment_type_id, start_at: chosen.start_at, end_at: chosen.end_at,
      }),
    });
  },
});
