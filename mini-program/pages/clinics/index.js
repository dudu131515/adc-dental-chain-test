const {request} = require("../../services/api");
const patient = require("../../services/patient");
Page({
  data: {loading:true, entries:[]},
  onShow() { return patient.loadPatient(this, async () => ({entries: (await request("/clinics")).items})); },
  profile: patient.profile,
  book(event) { wx.navigateTo({url: "/pages/booking/index?clinic_id=" + encodeURIComponent(event.currentTarget.dataset.id)}); },
  copy(event) { wx.setClipboardData({data: event.currentTarget.dataset.address}); },
});
