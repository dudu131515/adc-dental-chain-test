const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("the native project registers the patient home, appointments and account tabs with native icons", () => {
  const manifest = path.join(root, "app.json");
  assert.ok(fs.existsSync(manifest), "missing native app manifest");
  const app = JSON.parse(fs.readFileSync(manifest, "utf8"));
  assert.deepEqual(app.tabBar.list.map(({pagePath, text}) => [pagePath, text]), [
    ["pages/home/index", "首页"],
    ["pages/appointments/index", "预约"],
    ["pages/account/index", "我的"],
  ]);
  assert.equal(app.pages[0], "pages/home/index");
  for (const page of app.tabBar.list) {
    for (const icon of [page.iconPath, page.selectedIconPath]) assert.ok(fs.statSync(path.join(root, icon)).size > 0);
    assert.ok(app.pages.includes(page.pagePath));
    for (const suffix of [".js", ".json", ".wxml"]) {
      assert.ok(fs.existsSync(path.join(root, page.pagePath + suffix)));
    }
  }
});

test("local native builds use the shared API base", () => {
  const modulePath = path.join(root, "services/environment.js");
  assert.ok(fs.existsSync(modulePath), "missing environment configuration");
  const { apiBase } = require(modulePath);
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }) };
  assert.equal(apiBase(), "http://127.0.0.1:8000/api/v1");
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: "trial" } }) };
  assert.throws(() => apiBase(), /HTTPS/);
});
