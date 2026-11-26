const assert = require("node:assert/strict");
const test = require("node:test");
const manifest = require("../app.json");

function loadPage(path) {
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[require.resolve(path)];
  require(path);
  return {
    ...definition, data: {...definition.data},
    setData(fields) { Object.assign(this.data, fields); },
  };
}

function mockWechat(reply, navigateTo = () => {}) {
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: {envVersion: "develop"} }),
    login: ({ success }) => success({ code: "finance-logic-test" }),
    navigateTo,
    request(options) {
      const path = options.url.split("/api/v1")[1];
      const ok = data => options.success({ statusCode: 200, data: {data} });
      const error = (statusCode, message) => options.success({statusCode, data:{error:{message}}});
      if (path === "/auth/mini/login") return ok({patient_id: "1", token: "own-invoices", profile_required: false});
      assert.equal(options.header.Authorization, "Bearer own-invoices");
      assert.equal(options.method, "GET");
      reply(path, ok, error);
    },
  };
}

const summary = {
  invoice_id: "8", invoice_no: "INV-8", visit_date: "2026-03-03",
  clinic: {clinic_id: "1", name: "合成甲店"},
  status: "PART_PAID", accrued: "80.00", outstanding: "20.00",
};

test("native invoice list runs through loading, empty, failure and cursor pagination", async () => {
  assert.ok(manifest.pages.includes("pages/invoices/index"));
  const page = loadPage("../pages/invoices/index");
  let stage = "empty";
  let target;
  mockWechat((path, ok, error) => {
    if (stage === "empty") return ok({items: [], next_cursor: null});
    if (stage === "error") return error(503, "暂时无法查询费用单");
    if (path === "/patients/me/invoices") return ok({items: [summary], next_cursor: "safe-cursor"});
    assert.equal(path, "/patients/me/invoices?cursor=safe-cursor");
    ok({items: [{...summary, invoice_id: "7", invoice_no: "INV-7"}], next_cursor: null});
  }, ({url}) => { target = url; });
  await page.onShow();
  assert.deepEqual(page.data.entries, []);
  assert.equal(page.data.loading, false);
  stage = "error";
  await page.onShow();
  assert.equal(page.data.error, "暂时无法查询费用单");
  stage = "loaded";
  await page.onShow();
  await page.more();
  assert.deepEqual(page.data.entries.map(row => row.invoice_no), ["INV-8", "INV-7"]);
  assert.equal(page.data.nextCursor, null);
  page.open({currentTarget: {dataset: {id: "8"}}});
  assert.equal(target, "/pages/invoice-detail/index?id=8");
});

test("native account and appointment open the same patient invoice detail while appointment keeps deposit", async () => {
  assert.ok(manifest.pages.includes("pages/invoice-detail/index"));
  const account = loadPage("../pages/account/index");
  const appointment = loadPage("../pages/appointment-detail/index");
  const detail = loadPage("../pages/invoice-detail/index");
  const targets = [];
  const funds = [{kind: "REFUND", status: "PENDING", amount: "7.00", receipt_at: null}];
  mockWechat((path, ok) => {
    if (path === "/appointments/21") return ok({
      appointment_id:"21", start_at:"2026-03-03T05:00:00Z", end_at:"2026-03-03T05:30:00Z",
      status:"COMPLETED", clinic:summary.clinic, dentist:{name:"合成医生"}, treatment:{name:"合成项目"}, deposit:{amount:"50.00", status:"PAID"},
    });
    if (path === "/patients/me/invoices?appointment_id=21&limit=1") return ok({items:[summary], next_cursor:null});
    assert.equal(path, "/patients/me/invoices/8");
    ok({...summary, original_total:"120.00", received:"60.00", refunded:"0.00",
      pending_refund:"7.00", refund_due:"0.00", lines:[], adjustments:[{signed_amount:"-40.00"}], funds});
  }, ({url}) => targets.push(url));
  account.invoices();
  appointment.onLoad({id:"21"});
  await appointment.onShow();
  assert.equal(appointment.data.deposit.amount, "50.00");
  assert.equal(appointment.data.invoiceId, "8");
  appointment.openInvoice();
  assert.deepEqual(targets, ["/pages/invoices/index", "/pages/invoice-detail/index?id=8"]);
  detail.onLoad({id:"8"});
  await detail.onShow();
  assert.equal(detail.data.invoice.invoice_no, "INV-8");
  assert.equal(detail.data.invoice.statusLabel, "部分收款");
  assert.equal(detail.data.invoice.pending_refund, "7.00");
  assert.equal(detail.data.invoice.funds[0].label, "退款处理中");
  assert.equal(detail.data.invoice.deposit, undefined);
});
