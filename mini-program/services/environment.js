// Experience and release builds set this to the approved HTTPS host.
const EXPERIENCE_API_BASE = "";
const LOCAL_API_BASE = "http://127.0.0.1:8000/api/v1";
const LOCAL_SYNTHETIC_LOGIN_CODE = "adc-local-preview";

function development() {
  return wx.getAccountInfoSync().miniProgram.envVersion === "develop";
}

function apiBase() {
  if (development()) {
    return LOCAL_API_BASE;
  }
  if (!/^https:\/\/[^/]+\/api\/v1$/.test(EXPERIENCE_API_BASE)) {
    throw new Error("体验环境需要配置合法 HTTPS API 域名。");
  }
  return EXPERIENCE_API_BASE;
}

function localSyntheticLoginCode() {
  return development() && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/api\/v1$/.test(LOCAL_API_BASE)
    ? LOCAL_SYNTHETIC_LOGIN_CODE
    : "";
}

module.exports = { apiBase, localSyntheticLoginCode };
