const {request} = require("../../services/api");
const patient = require("../../services/patient");
Page({
  data: {loading:true, person:{}},
  onShow() {
    return patient.loadPatient(this, async () => {
      const person = await request("/patients/me");
      return {person, avatar: Array.from(person.full_name || "")[0] || "我"};
    });
  },
  profile: patient.profile, receipts: patient.receipts, clinics: patient.clinics,
  history() { patient.appointments("history"); },
});
