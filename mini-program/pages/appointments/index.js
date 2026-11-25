const {request} = require("../../services/api");
const {groupAppointments} = require("../../services/booking");
const patient = require("../../services/patient");
Page({
  data: {upcoming: [], history: [], section:"upcoming", loading: true},
  onShow() {
    const app = getApp();
    if (app.globalData.appointmentView) {
      this.setData({section: app.globalData.appointmentView});
      delete app.globalData.appointmentView;
    }
    return patient.loadPatient(this, async () => groupAppointments((await request("/appointments")).items));
  },
  chooseSection(event) { this.setData({section: event.currentTarget.dataset.section}); },
  open(event) { patient.openAppointment(event.currentTarget.dataset.id); },
  profile: patient.profile, book: patient.book,
});
