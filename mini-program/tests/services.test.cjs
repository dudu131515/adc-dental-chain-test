const assert = require("node:assert/strict");
const test = require("node:test");

global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }) };

test("the native request wrapper sends the current bearer and clears it on expiry", async () => {
  const { request, accessToken } = require("../services/api");
  let header;
  global.wx.request = ({ header: value, success }) => {
    header = value;
    success({ statusCode: 401, data: { error: { code: "AUTHENTICATION_REQUIRED" } } });
  };
  accessToken.set("test-synthetic-token");
  await assert.rejects(request("/appointments"), { code: "AUTHENTICATION_REQUIRED" });
  assert.equal(header.Authorization, "Bearer test-synthetic-token");
  assert.equal(accessToken.get(), "");
});

test("POST timeout preserves the action key for result verification", async () => {
  const { request } = require("../services/api");
  let suppliedKey;
  global.wx.request = ({ header, fail }) => {
    suppliedKey = header["Idempotency-Key"];
    fail({ errMsg: "request timeout" });
  };
  await assert.rejects(request("/holds", { method: "POST", data: {}, actionKey: "hold-attempt-42" }), {
    code: "RESULT_UNKNOWN", actionKey: "hold-attempt-42",
  });
  assert.equal(suppliedKey, "hold-attempt-42");
});
