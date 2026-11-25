const { request } = require("./api");
const { apiBase } = require("./environment");
const { query } = require("./booking");

function storageKey(identity) {
  if (!identity || !identity.account_id || identity.profile_required) return "";
  return "adc-deposit-attempts:" + apiBase() + ":" + identity.account_id;
}

function attempts(identity) {
  const key = storageKey(identity);
  const saved = key && wx.getStorageSync(key);
  return Array.isArray(saved) ? saved : [];
}

function remember(identity, entry) {
  const key = storageKey(identity);
  if (!key) return;
  const saved = attempts(identity);
  if (!saved.some(row => row.key === entry.key)) wx.setStorageSync(key, [...saved, entry]);
}

function forget(identity, entryKey) {
  const key = storageKey(identity);
  if (!key) return;
  try {
    const saved = attempts(identity);
    const remaining = saved.filter(entry => entry.key !== entryKey);
    if (remaining.length !== saved.length) wx.setStorageSync(key, remaining);
  } catch {
    // Stored actions can be safely rechecked if cleanup fails.
  }
}

function lookup(entry) {
  return request("/holds/by-action?" + query({ clinic_id: entry.payload.clinic_id }), { actionKey: entry.key });
}

module.exports = { attempts, remember, forget, lookup };
