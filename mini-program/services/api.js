const { apiBase } = require("./environment");

let token = "";

const accessToken = {
  get() { return token; },
  set(value) { token = value; },
  clear() { token = ""; },
};

class ApiError extends Error {
  constructor(status, error, actionKey) {
    super(error.message || "暂时无法完成，请重试。");
    this.status = status;
    this.code = error.code || "SERVER_ERROR";
    this.fieldErrors = error.field_errors || {};
    this.requestId = error.request_id;
    this.details = error.details || {};
    this.actionKey = actionKey;
  }
}

function request(path, options = {}) {
  const { method = "GET", data, actionKey, publicRequest = false } = options;
  const read = method === "GET";
  const header = { "Content-Type": "application/json", Accept: "application/json" };
  if (token && !publicRequest) header.Authorization = "Bearer " + token;
  if (actionKey) header["Idempotency-Key"] = actionKey;
  return new Promise((resolve, reject) => {
    function unknownResult(status, error = {}) {
      reject(new ApiError(status, {
        code: "RESULT_UNKNOWN", message: "办理结果待核对，请先查询原操作。", request_id: error.request_id,
      }, actionKey));
    }

    wx.request({
      url: apiBase() + path,
      method,
      data,
      header,
      timeout: 12000,
      success(response) {
        const { statusCode, data: payload } = response;
        if (statusCode === 401 && !publicRequest) accessToken.clear();
        if (statusCode === 204) {
          resolve(undefined);
          return;
        }
        const apiError = payload?.error || {};
        if (statusCode >= 200 && statusCode < 300) {
          if (payload && typeof payload === "object" && payload.data != null) {
            resolve(payload.data);
          } else if (read) {
            reject(new ApiError(statusCode, { code: "INVALID_RESPONSE", message: "无法读取办理结果，请重新查询。" }));
          } else {
            unknownResult(statusCode);
          }
        } else if (!read && statusCode >= 500) {
          unknownResult(statusCode, apiError);
        } else {
          reject(new ApiError(statusCode, apiError, actionKey));
        }
      },
      fail() {
        if (read) {
          reject(new ApiError(0, { code: "NETWORK_ERROR", message: "连接中断，请重试查询。" }, actionKey));
        } else {
          unknownResult(0);
        }
      },
    });
  });
}

async function resolveUnknown(lookup, retry) {
  try {
    return await lookup();
  } catch (error) {
    if (error.status !== 404) throw error;
    return retry();
  }
}

module.exports = { request, accessToken, resolveUnknown };
