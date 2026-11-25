const { request, accessToken } = require("./api");
const { localSyntheticLoginCode } = require("./environment");

let pendingLogin;
let currentIdentity;

function acceptIdentity(identity) {
  currentIdentity = identity;
  if (identity.token) accessToken.set(identity.token);
  return identity;
}

function codeFromWechat() {
  const synthetic = localSyntheticLoginCode();
  if (synthetic) return Promise.resolve(synthetic);
  return new Promise((resolve, reject) => {
    wx.login({
      success(result) {
        if (result.code) resolve(result.code);
        else reject(new Error("未取得微信身份，请重新登录。"));
      },
      fail() { reject(new Error("未能登录微信，请重试。")); },
    });
  });
}

function ensureSession() {
  if (currentIdentity && (accessToken.get() || currentIdentity.profile_required)) {
    return Promise.resolve(currentIdentity);
  }
  if (!pendingLogin) {
    pendingLogin = codeFromWechat()
      .then(code => request("/auth/mini/login", { method: "POST", data: { code }, publicRequest: true }))
      .then(acceptIdentity)
      .finally(() => { pendingLogin = undefined; });
  }
  return pendingLogin;
}

function bindProfile(profile) {
  return ensureSession().then(identity => {
    if (!identity.profile_required) return identity;
    return request("/auth/mini/bind-profile", {
      method: "POST", publicRequest: true, data: { ...profile, profile_token: identity.profile_token },
    }).then(acceptIdentity);
  });
}

async function logout() {
  try {
    if (accessToken.get()) await request("/auth/logout", { method: "POST" });
  } finally {
    accessToken.clear();
    currentIdentity = undefined;
  }
}

module.exports = { ensureSession, bindProfile, logout };
