const assert = require("node:assert/strict");
const test = require("node:test");
const { request, accessToken } = require("../services/api");

const slot = {
  clinic_id: "2", dentist_id: "3", shift_id: "4", treatment_type_id: "5",
  start_at: "2031-01-08T10:00:00+08:00", end_at: "2031-01-08T10:30:00+08:00",
};
const clinics = [{ clinic_id: "1", name: "中心门店" }, { clinic_id: "2", name: "西区门店" }];
const treatments = [{ treatment_type_id: "5", treatment_name: "检查", default_slot_minutes: 30 }];
function page(name) {
  let definition;
  global.Page = value => { definition = value; };
  const path = require.resolve("../pages/" + name + "/index");
  delete require.cache[path];
  require(path);
  return { ...definition, data: { ...definition.data }, setData(fields) { Object.assign(this.data, fields); } };
}

function wechat(handle) {
  const storage = new Map(), calls = [], navigation = [];
  let account = "1";
  accessToken.clear();
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    login: ({ success }) => success({ code: account }),
    navigateTo: ({ url }) => navigation.push(url),
    navigateBack: () => navigation.push("back"),
    request(options) {
      const path = options.url.split("/api/v1")[1];
      calls.push({ path, method: options.method, key: options.header["Idempotency-Key"], data: options.data });
      const ok = data => options.success({ statusCode: 200, data: { data } });
      if (path === "/auth/mini/login") {
        return ok({ account_id: account, patient_id: account, token: "test-" + account, profile_required: false });
      }
      if (path === "/clinics") return ok({ items: clinics });
      if (path === "/catalog/treatments") return ok({ items: treatments });
      if (path === "/patients/me") return ok({ full_name: "测试患者" });
      if (path === "/appointments") return ok({ items: [] });
      return handle(path, options, ok);
    },
  };
  return { calls, navigation, account(value) { account = value; accessToken.clear(); } };
}
function hold(status = "HOLD", paymentStatus = "NOT_STARTED") {
  const now = Date.now();
  return {
    clinic_id: slot.clinic_id, claim_id: "6", status, start_at: slot.start_at, end_at: slot.end_at,
    expires_at: new Date(now + 600_000).toISOString(), server_time: new Date(now).toISOString(),
    payment: { deposit_id: "7", amount: "50.00", status: paymentStatus },
  };
}

test("write HTTP failures and malformed successes keep the action key and unknown outcome", async () => {
  for (const response of [
    { statusCode: 503, data: { error: { code: "SERVICE_UNAVAILABLE" } } },
    { statusCode: 201, data: "<html>" },
    { statusCode: 200, data: null },
    { statusCode: 200, data: { data: null } },
  ]) {
    wechat((path, options) => options.success(response));
    await assert.rejects(request("/holds", { method: "POST", actionKey: "original" }), {
      code: "RESULT_UNKNOWN", actionKey: "original",
    });
  }
});

test("an unsuccessful hold lookup keeps recovery on the original GET and key", async () => {
  let lookups = 0;
  const { calls } = wechat((path, options, ok) => {
    if (path === "/holds") return options.fail();
    assert.equal(path, "/holds/by-action?clinic_id=2");
    if (++lookups === 1) return options.fail();
    if (lookups === 2) return options.success({ statusCode: 503, data: {} });
    return ok(hold());
  });
  const confirm = page("booking-confirm");
  confirm.onLoad(slot);
  await confirm.onShow();
  try {
    await confirm.reserve();
    await confirm.reserve();
    assert.equal(confirm.data.unknown, true);
    await confirm.reserve();
    assert.equal(confirm.data.unknown, true);
    await confirm.reserve();
    assert.equal(confirm.data.hold.claim_id, "6");
    const recovery = calls.filter(call => call.path.startsWith("/holds"));
    assert.deepEqual(recovery.map(call => call.method), ["POST", "GET", "GET", "GET"]);
    assert.equal(new Set(recovery.map(call => call.key)).size, 1);
  } finally { confirm.onUnload(); }
});

test("booking from a specific clinic uses that clinic for the availability route", async () => {
  const { navigation } = wechat(path => assert.fail(path));
  const directory = page("clinics");
  directory.book({ currentTarget: { dataset: { id: "2" } } });
  const booking = page("booking");
  booking.onLoad({ clinic_id: new URL(navigation[0], "https://local.invalid").searchParams.get("clinic_id") });
  await booking.onShow();
  assert.equal(booking.data.clinics[booking.data.clinicIndex].name, "西区门店");
  booking.continue();
  assert.match(navigation[1], /^\/pages\/time-selection\/index\?clinic_id=2&/);
});

test("released deferred payment remains queryable in receipts for the original account", async () => {
  let deposit = { deposit_id: "7", amount: "50.00", status: "PENDING", claim_status: "HOLD" };
  let release = false;
  const runtime = wechat((path, options, ok) => {
    if (path === "/holds") return ok(hold());
    if (path === "/holds/by-action?clinic_id=2") {
      return ok(hold(release ? "RELEASED" : "HOLD", deposit.status));
    }
    if (path === "/deposit-payments/7/simulate" || path === "/deposit-payments/7") return ok(deposit);
    if (path === "/holds/6/release") { release = true; return ok(hold("RELEASED", "PENDING")); }
    assert.fail(path);
  });
  const confirm = page("booking-confirm");
  confirm.onLoad(slot);
  await confirm.onShow();
  try {
    await confirm.reserve();
    await confirm.pay();
    assert.equal(confirm.data.payment.status, "PENDING");
    await confirm.pay();
    assert.equal(runtime.calls.filter(call => call.path.endsWith("/simulate")).length, 1);
    await confirm.abandon();
    assert.equal(runtime.navigation.at(-1), "back");
  } finally { confirm.onUnload(); }

  deposit = { ...deposit, status: "PAID", claim_status: "RELEASED", refund: { refund_id: "8", amount: "50.00", status: "PENDING" } };
  const receipts = page("receipts");
  await receipts.onShow();
  assert.equal(receipts.data.entries.length, 1);
  const [entry] = receipts.data.entries;
  assert.equal(entry.paymentLabel, "已支付");
  assert.equal(entry.refundLabel, "处理中");
  assert.equal(entry.refundAmount, "50.00");
  assert.ok(!entry.appointmentId);
  deposit.refund.status = "SUCCEEDED";
  await receipts.onShow();
  assert.equal(receipts.data.entries[0].refundLabel, "已退款");

  runtime.account("2");
  const priorReads = runtime.calls.length;
  await receipts.onShow();
  assert.deepEqual(receipts.data.entries, []);
  assert.deepEqual(runtime.calls.slice(priorReads).map(call => call.path), ["/auth/mini/login", "/appointments"]);
});

test("an unresolved hold can reopen and retry with its original key and inputs", async () => {
  let submissions = 0, lookups = 0;
  const runtime = wechat((path, options, ok) => {
    if (path === "/holds") {
      if (++submissions === 1) return options.fail();
      return ok(hold());
    }
    if (path === "/holds/by-action?clinic_id=2") {
      if (++lookups === 2) return options.fail();
      return options.success({ statusCode: 404, data: { error: { code: "NOT_FOUND" } } });
    }
    assert.fail(path);
  });

  const original = page("booking-confirm");
  original.onLoad(slot);
  await original.onShow();
  await original.reserve();
  original.onUnload();

  const receipts = page("receipts");
  await receipts.onShow();
  assert.equal(receipts.data.entries[0].paymentLabel, "待核对");
  receipts.open({ currentTarget: { dataset: { resume: receipts.data.entries[0].resumeKey } } });
  const url = new URL(runtime.navigation.at(-1), "https://local.invalid");
  assert.equal(url.pathname, "/pages/booking-confirm/index");

  const restored = page("booking-confirm");
  restored.onLoad({ resume: url.searchParams.get("resume") });
  await restored.onShow();
  try {
    assert.equal(restored.data.unknown, true);
    assert.equal(restored.data.profile?.full_name, "测试患者");
    await restored.reserve();
    assert.equal(restored.data.hold.payment.deposit_id, "7");
    const requests = runtime.calls.filter(call => call.path.startsWith("/holds"));
    assert.deepEqual(requests.map(call => call.method), ["POST", "GET", "GET", "GET", "POST"]);
    assert.equal(new Set(requests.map(call => call.key)).size, 1);
    assert.deepEqual(requests.at(-1).data, requests[0].data);
  } finally { restored.onUnload(); }
});
