const { request } = require("../../services/api");
const { query } = require("../../services/booking");
const patient = require("../../services/patient");

function display(entry) {
  return {...entry, statusLabel: patient.invoiceStatus(entry.status), settled: Number(entry.outstanding) <= 0};
}
function shown(entries, section) {
  if (section === "unpaid") return entries.filter(entry => !entry.settled);
  if (section === "settled") return entries.filter(entry => entry.settled);
  return entries;
}
function counts(entries) {
  return {all: entries.length, unpaid: entries.filter(entry => !entry.settled).length,
    settled: entries.filter(entry => entry.settled).length};
}

Page({
  data: { loading: true, entries: [], allEntries: [], counts: {all: 0, unpaid: 0, settled: 0},
    section: "all", nextCursor: null, loadingMore: false, moreError: "" },
  onShow() {
    this.setData({entries: [], allEntries: [], nextCursor: null, loadingMore: false, moreError: "", section: "all"});
    return patient.loadPatient(this, async () => {
      const result = await request("/patients/me/invoices");
      const allEntries = result.items.map(display);
      return {allEntries, entries: shown(allEntries, "all"), counts: counts(allEntries), nextCursor: result.next_cursor};
    });
  },
  chooseSection(event) {
    const section = event.currentTarget.dataset.section;
    this.setData({section, entries: shown(this.data.allEntries, section), moreError: ""});
  },
  async more() {
    const { nextCursor, loadingMore } = this.data;
    if (!nextCursor || loadingMore) return;
    const version = this.loadVersion;
    this.setData({loadingMore: true, moreError: ""});
    try {
      const result = await request("/patients/me/invoices?" + query({cursor: nextCursor}));
      if (version === this.loadVersion) {
        const allEntries = [...this.data.allEntries, ...result.items.map(display)];
        this.setData({allEntries, entries: shown(allEntries, this.data.section), counts: counts(allEntries),
          nextCursor: result.next_cursor});
      }
    } catch (failure) {
      if (version === this.loadVersion) {
        if (failure.status === 401 || failure.status === 403) {
          this.setData({entries: [], allEntries: [], nextCursor: null, error: failure.message});
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
