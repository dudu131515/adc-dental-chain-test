const { request } = require("../../services/api");
const { query } = require("../../services/booking");
const patient = require("../../services/patient");

function display(entry) {
  return {...entry, statusLabel: patient.invoiceStatus(entry.status)};
}

Page({
  data: { loading: true, entries: [], nextCursor: null, loadingMore: false, moreError: "" },
  onShow() {
    this.setData({entries: [], nextCursor: null, loadingMore: false, moreError: ""});
    return patient.loadPatient(this, async () => {
      const result = await request("/patients/me/invoices");
      return {entries: result.items.map(display), nextCursor: result.next_cursor};
    });
  },
  async more() {
    const { nextCursor, loadingMore } = this.data;
    if (!nextCursor || loadingMore) return;
    const version = this.loadVersion;
    this.setData({loadingMore: true, moreError: ""});
    try {
      const result = await request("/patients/me/invoices?" + query({cursor: nextCursor}));
      if (version === this.loadVersion) {
        this.setData({entries: [...this.data.entries, ...result.items.map(display)], nextCursor: result.next_cursor});
      }
    } catch (failure) {
      if (version === this.loadVersion) {
        if (failure.status === 401 || failure.status === 403) {
          this.setData({entries: [], nextCursor: null, error: failure.message});
        } else {
          this.setData({moreError: failure.message});
        }
      }
    } finally {
      if (version === this.loadVersion) this.setData({loadingMore: false});
    }
  },
  open(event) { patient.openInvoice(event.currentTarget.dataset.id); },
  profile: patient.profile,
});
