const {request} = require("../../services/api");
const {groupAppointments} = require("../../services/booking");
const patient = require("../../services/patient");
Page({
  data: {loading:true, person:{}},
  onShow() {
    return patient.loadPatient(this, async () => {
      const [person, appointments, invoices] = await Promise.all([
        request("/patients/me"), request("/appointments"), request("/patients/me/invoices"),
      ]);
      const upcoming = groupAppointments(appointments.items).upcoming;
      const outstanding = invoices.items.reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
      return {
        person, avatar: Array.from(person.full_name || "")[0] || "我",
        upcomingCount: upcoming.length, invoiceCount: invoices.items.length,
        outstanding: outstanding.toFixed(2),
      };
    });
  },
  profile: patient.profile, receipts: patient.receipts, invoices: patient.invoices, clinics: patient.clinics,
  history() { patient.appointments("history"); },
});
