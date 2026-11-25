export function localDay(value = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}

export function dateTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short", hourCycle: "h23",
  }).format(new Date(value));
}

export function money(value?: string | null) {
  return value == null ? "—" : "¥" + value;
}

export function errorMessage(error: unknown, fallback = "暂时无法完成，请重试。") {
  return error instanceof Error ? error.message : fallback;
}
