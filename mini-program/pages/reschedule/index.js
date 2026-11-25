const { request } = require("../../services/api");
const { actionKey, appointmentSummary, localDate, localTime, query, slotLabel } = require("../../services/booking");

Page({
  data: { clinics: [], clinicIndex: 0, slots: [], selected: -1, loading: true, pending: false },

  async onLoad(params) {
    this.id = params.id;
    try {
      const [original, result] = await Promise.all([request("/appointments/" + this.id), request("/clinics")]);
      this.original = original;
      this.setData({
        initial: appointmentSummary(original),
        clinics: result.items,
        clinicIndex: Math.max(0, result.items.findIndex(x => x.clinic_id === original.clinic.clinic_id)),
        date: localDate(original.start_at), time: "",
      });
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  reset(fields) {
    this.key = undefined;
    this.unknown = false;
    this.setData({ ...fields, selected: -1, slots: [], queried: false, unknown: false });
  },
  chooseClinic(event) { this.reset({ clinicIndex: Number(event.detail.value) }); },
  chooseDate(event) { this.reset({ date: event.detail.value }); },
  chooseTime(event) { this.reset({ time: event.detail.value }); },

  async find() {
    if (!this.original || this.data.pending) return;
    const clinic = this.data.clinics[this.data.clinicIndex];
    if (!clinic) return;
    this.setData({ pending: true, error: "", slots: [], selected: -1 });
    try {
      const params = {
        appointment_id: this.id, clinic_id: clinic.clinic_id, date: this.data.date,
        treatment_type_id: this.original.treatment.treatment_type_id,
      };
      if (this.data.time) params.preferred_start_at = this.data.date + "T" + this.data.time + ":00+08:00";
      const result = await request("/booking/options?" + query(params));
      this.setData({ queried: true, slots: result.items.map(row => ({
        ...row, id: row.shift_id + ":" + row.start_at,
        time: localTime(row.start_at) + "–" + localTime(row.end_at),
      })) });
    } catch (failure) {
      this.setData({ error: failure.message });
    } finally {
      this.setData({ pending: false });
    }
  },

  select(event) {
    if (this.data.pending || this.unknown) return;
    const selected = event.currentTarget.dataset.index;
    const slot = this.data.slots[selected];
    this.key = actionKey("reschedule");
    this.setData({ selected, proposed: slotLabel(slot.start_at, slot.end_at) });
  },

  async submit() {
    const slot = this.data.slots[this.data.selected];
    if (!slot || this.data.pending) return;
    this.setData({ pending: true, error: "" });
    let checking = Boolean(this.unknown);
    try {
      if (checking) {
        const current = await request("/appointments/" + this.id);
        if (current.claim_id !== this.original.claim_id) {
          wx.navigateBack();
          return;
        }
      }
      checking = false;
      await request("/appointments/" + this.id + "/reschedule", {
        method: "POST", actionKey: this.key,
        data: {
          expected_claim_id: this.original.claim_id, cause: "PATIENT", reason: "患者在本人入口申请改期",
          clinic_id: slot.clinic_id, shift_id: slot.shift_id, dentist_id: slot.dentist_id,
          start_at: slot.start_at, end_at: slot.end_at,
        },
      });
      wx.navigateBack();
    } catch (failure) {
      this.unknown = checking || failure.code === "RESULT_UNKNOWN";
      this.setData({ unknown: Boolean(this.unknown), error: failure.message });
    } finally {
      this.setData({ pending: false });
    }
  },
});
