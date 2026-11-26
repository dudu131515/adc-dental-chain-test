const { ensureSession } = require("./session");

async function loadPatient(page, fetchData) {
  const version = (page.loadVersion || 0) + 1;
  page.loadVersion = version;
  page.setData({loading: true, error: ""});
  try {
    const identity = await ensureSession();
    const profileRequired = Boolean(identity.profile_required);
    const fields = profileRequired ? {} : await fetchData(identity);
    if (version === page.loadVersion) page.setData({...fields, profileRequired});
  } catch (failure) {
    if (version === page.loadVersion) page.setData({error: failure.code === "RESULT_UNKNOWN" ? "暂时无法连接就诊服务，请重新加载。" : failure.message});
  } finally {
    if (version === page.loadVersion) page.setData({loading: false});
  }
}
function book() { wx.navigateTo({url: "/pages/booking/index"}); }
function profile() { wx.navigateTo({url: "/pages/profile/index"}); }
function receipts() { wx.navigateTo({url: "/pages/receipts/index"}); }
function clinics() { wx.navigateTo({url: "/pages/clinics/index"}); }
function appointments(section) {
  getApp().globalData.appointmentView = section;
  wx.switchTab({url: "/pages/appointments/index"});
}
function openAppointment(id) { wx.navigateTo({url: "/pages/appointment-detail/index?id=" + encodeURIComponent(id)}); }
function invoices() { wx.navigateTo({url: "/pages/invoices/index"}); }
function openInvoice(id) { wx.navigateTo({url: "/pages/invoice-detail/index?id=" + encodeURIComponent(id)}); }
const invoiceStatuses = { ISSUED: "已开立", PART_PAID: "部分收款", SETTLED: "已结清" };
function invoiceStatus(status) { return invoiceStatuses[status] || "已开立"; }
module.exports = {loadPatient, book, profile, receipts, invoices, openInvoice, invoiceStatus, clinics, appointments, openAppointment};
