type Failure = {
  code: string;
  message: string;
  field_errors?: Record<string, string | string[]>;
  request_id?: string;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly error: Failure, public readonly actionKey?: string) {
    super(error.message);
  }
}

type RequestDetails = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  actionKey?: string;
  signal?: AbortSignal;
};

async function send<T>(path: string, details: RequestDetails, csrf?: string): Promise<T> {
  const { method = "GET", body, actionKey, signal } = details;
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (csrf) headers.set("X-CSRFToken", csrf);
  if (actionKey) headers.set("Idempotency-Key", actionKey);
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      credentials: "same-origin", method, headers, signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const read = method === "GET";
    throw new ApiError(0, {
      code: read ? "NETWORK_ERROR" : "RESULT_UNKNOWN",
      message: read ? "连接中断，请重试查询。" : "办理结果待核对，请先查询原操作。",
    }, actionKey);
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  const hasData = payload && typeof payload === "object" && "data" in payload;
  if (!response.ok || !hasData) {
    if (response.status === 401 && path !== "/auth/web/login" && path !== "/auth/me") {
      window.dispatchEvent(new Event("adc:session-expired"));
    }
    if (method !== "GET" && (response.status >= 500 || response.ok)) {
      throw new ApiError(response.status, { code: "RESULT_UNKNOWN", message: "办理结果待核对，请先查询原操作。" }, actionKey);
    }
    throw new ApiError(response.status, payload?.error ?? {
      code: "SERVICE_UNAVAILABLE", message: "暂时无法取得办理结果。",
    }, actionKey);
  }
  return payload.data as T;
}

export async function request<T>(path: string, details: RequestDetails = {}): Promise<T> {
  if (!details.method || details.method === "GET") return send<T>(path, details);
  const { csrf_token } = await send<{ csrf_token: string }>("/auth/web/csrf", {});
  return send<T>(path, details, csrf_token);
}

export async function checkThenRetry<T>(lookup: () => Promise<T>, retry: () => Promise<T>): Promise<T> {
  try {
    return await lookup();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return retry();
  }
}
