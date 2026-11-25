const {request} = require("../../services/api");
const {groupAppointments, dateParts} = require("../../services/booking");
const patient = require("../../services/patient");
Page({
  data: {loading:true, next:null, expanded:""},
  onShow() {
    const today = dateParts(Date.now());
    this.setData({today: today.dateLabel + " " + today.weekday});
    return patient.loadPatient(this, async () => {
      const {items} = await request("/appointments");
      const {upcoming} = groupAppointments(items);
      return {next: upcoming[0] || null};
    });
  },
  book: patient.book, profile: patient.profile, receipts: patient.receipts, clinics: patient.clinics,
  history() { patient.appointments("history"); },
  all() { patient.appointments("upcoming"); },
  open() { if (this.data.next) patient.openAppointment(this.data.next.id); },
  toggleGuide(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({expanded: this.data.expanded === key ? "" : key});
  },
});
