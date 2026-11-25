const assert = require("node:assert/strict");
const test = require("node:test");

function loadPage(relative) {
  let definition;
  global.Page = input => { definition = input; };
  require(relative);
  return {
    ...definition,
    data: { ...definition.data },
    setData(fields) { Object.assign(this.data, fields); },
  };
}

test("a lost initial reserve response checks the original action key, then opens the same paid appointment", async () => {
  const { accessToken } = require("../services/api");
  accessToken.set("synthetic-test-token");
  const requests = [];
  let next;
  const storage = new Map();
  const server = new Date();
  const slot = {
    clinic_id: "1", dentist_id: "1", shift_id: "6", treatment_type_id: "3",
    start_at: "2031-01-08T10:00:00+08:00", end_at: "2031-01-08T10:30:00+08:00",
  };
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    redirectTo(options) { next = options.url; },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    login: ({ success }) => success({ code: "test-patient" }),
    request(options) {
      const path = options.url.split("/api/v1")[1];
      requests.push({ path, method: options.method, key: options.header["Idempotency-Key"] });
      const success = data => options.success({ statusCode: 200, data: { data } });
      if (path === "/auth/mini/login") return success({ account_id: "1", patient_id: "1", token: "test", profile_required: false });
      if (path === "/clinics" || path === "/catalog/treatments") return success({ items: [] });
      if (path === "/patients/me") return success({ full_name: "测试患者" });
      if (path === "/holds") return options.fail({ errMsg: "request timeout" });
      const payload = path.startsWith("/holds/by-action") ? {
        claim_id: "7", status: "HOLD", expires_at: new Date(+server + 600_000).toISOString(), server_time: server.toISOString(),
        payment: { deposit_id: "8", amount: "50.00", status: "NOT_STARTED" },
      } : {
        deposit_id: "8", claim_id: "7", status: "PAID", amount: "50.00", appointment_id: "10", appointment_no: "ADC-SYNTHETIC-10",
      };
      options.success({ statusCode: 200, data: { data: payload } });
    },
  };
  const page = loadPage("../pages/booking-confirm/index");
  page.onLoad(slot);
  await page.onShow();
  try {
    await page.reserve();
    assert.equal(page.data.unknown, true);
    await page.reserve();
    assert.equal(page.data.unknown, false);
    assert.equal(page.data.hold.payment.amount, "50.00");
    assert.equal(page.data.seconds, 600);
    const holds = requests.filter(row => row.path.startsWith("/holds"));
    assert.equal(holds[0].key, holds[1].key);
    assert.equal(holds[1].method, "GET");
    await page.pay();
    assert.equal(next, "/pages/appointment-detail/index?id=10");
    assert.equal(page.data.payment.appointment_no, "ADC-SYNTHETIC-10");
  } finally {
    page.onUnload();
    accessToken.clear();
  }
});
