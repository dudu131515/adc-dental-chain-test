import { addDays } from "../src/features/schedule/types";
import { ApiError } from "../src/shared/api";
import { clinics } from "./fixtures";

const sampleClinics = Object.entries(clinics).map(([clinic_id, name]) => ({ clinic_id, name }));
const clinicIds = sampleClinics.map(clinic => clinic.clinic_id);
const sampleDates = { date_from: "2026-11-24", date_to: "2026-11-26" };
const sampleCutoff = "2026-11-30T20:00:00+08:00";
const moneyKeys = ["received", "refunded", "net_received"] as const;
const metrics = {
  attendance_rate: /(?:实际)?就诊率|到诊率|接诊率/,
  unprocessed: /到期未处置|未处置预约/,
  net_received: /(?:诊疗)?净实收|诊疗收款|营收/,
  deposit_refund: /预约金(?:退还|退款)规则/,
  report_rules: /(?:预约)?统计口径/,
} as const;

type Metric = keyof typeof metrics;
type Bounds = typeof sampleDates;
type Scope = { clinic_ids: string[]; dentist_ids: string[] };
type Body = Record<string, unknown>;
type Rates = "attendance_rate" | "unprocessed";
type Source = { id: string; title: string; summary: string; version: string };
type Money = Record<(typeof moneyKeys)[number], string>;
type AppointmentCounts = {
  clinic_id: string; attended: number; unprocessed: number; no_show: number; patient_cancelled: number; unclassified?: number;
};
type Report = Bounds & { as_of: string; scope: Scope; report_token: string;
  appointments: { by_clinic: AppointmentCounts[] }; financial: Money };

const source = (id: string, title: string, summary: string): Source => ({ id, title, summary, version: "ADC 系统规约 · 2026-11-25" });
const denominatorRule = source("FR-602", "正式预约的归期和共享分母", "按最终时段的本地日期归期。已到期的接诊、患者取消、已核实爽约及未处置预约共用分母。");
const attendanceRule = source("FR-603", "实际就诊率和缺项", "实际接诊数除以共用分母。分母为零时显示不适用。");
const financialRule = source("FR-405", "诊疗资金核算", "净实收为成功收款减成功退款。预约金另行核算。");
const financialScope = source("FR-604", "授权经营指标及回查", "可在授权范围内核对实收、退款、净实收与明细。");
const depositRules = [
  source("FR-208", "预约金取消与退还", "符合普通取消条件时，距离开诊满 24 小时全退，满 2 小时且不足 24 小时退半，不足 2 小时留存。已签到或到开始时点请门店核实。"),
  source("FR-207", "诊所原因取消", "诊所原因无法履约且无法协商安排时，取消并全额原路退还。"),
  source("FR-304", "实际接诊退金", "实际开始接诊时登记全额原路退还义务。"),
  source("FR-210", "退金回执", "匹配的成功回执才记为已退。"),
];

function problem(status: number, code: string, message: string): never {
  throw new ApiError(status, { code, message });
}

function toList(value: unknown) {
  return [...new Set((Array.isArray(value) ? value.map(String) : String(value ?? "").split(",")).filter(Boolean))];
}

function dateBounds(first: string, last: string): Bounds {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && addDays(value, 0) === value;
  if (!valid(first) || !valid(last) || first > last || (Date.parse(last) - Date.parse(first)) / 86400000 >= 366) {
    problem(400, "VALIDATION_ERROR", "请选择有效期间，每个期间最多 366 天。");
  }
  return { date_from: first, date_to: last };
}

function priorBounds({ date_from, date_to }: Bounds): Bounds {
  const days = Math.round((Date.parse(date_to) - Date.parse(date_from)) / 86400000) + 1;
  const offset = -Math.max(7, days);
  return { date_from: addDays(date_from, offset), date_to: addDays(date_to, offset) };
}

function comparisonDates(bounds: Bounds) {
  return { comparison_date_from: bounds.date_from, comparison_date_to: bounds.date_to };
}

function scopeOf(clinicFilter: unknown, dentistFilter: unknown): Scope {
  const selected = toList(clinicFilter);
  if (selected.some(id => !clinicIds.includes(id))) problem(403, "PERMISSION_DENIED", "请选择可查询的样例门店。");
  return { clinic_ids: selected.length ? selected : clinicIds, dentist_ids: toList(dentistFilter) };
}

function suggestions(query: URLSearchParams) {
  const bounds = dateBounds(query.get("date_from") || sampleDates.date_from, query.get("date_to") || sampleDates.date_to);
  const selection = { ...bounds, ...scopeOf(query.get("clinic_ids"), query.get("dentist_ids")) };
  return { clinics: sampleClinics, suggestions: [
    { id: "weekly_attendance", label: "对比两店实际就诊率", selection: { ...selection, clinic_ids: clinicIds,
      ...comparisonDates(priorBounds(bounds)), metric: "attendance_rate" } },
    { id: "unprocessed", label: "查看到期未处置预约", selection: { ...selection, metric: "unprocessed" } },
    { id: "net_received", label: "诊疗净实收如何变化", selection: { ...selection,
      ...comparisonDates(priorBounds(bounds)), metric: "net_received" } },
    { id: "deposit_refund", label: "查询预约金退还规则", selection: { ...selection, metric: "deposit_refund" } },
  ] };
}

function interpretation(body: Body) {
  const question = typeof body.question === "string" ? body.question.normalize("NFKC").replace(/\s+/g, "") : "";
  const scopes = scopeOf(body.clinic_ids, body.dentist_ids);
  const named = sampleClinics.filter(clinic => question.includes(clinic.name.replace(/\s+/g, "")));
  const scope = { ...scopes, clinic_ids: /两家门店|两店/.test(question) ? clinicIds
    : named.length ? named.map(clinic => clinic.clinic_id) : scopes.clinic_ids };
  const metric = question
    ? (Object.keys(metrics) as Metric[]).find(key => metrics[key].test(question))
    : (Object.keys(metrics) as Metric[]).find(key => key === body.metric);
  if (!metric) problem(400, question ? "QUESTION_NEEDS_SELECTION" : "VALIDATION_ERROR", "请通过选项补全门店、统计期间和指标。");
  const ranges = [...question.matchAll(/(\d{4}-\d{2}-\d{2})(?:至|到|~)(\d{4}-\d{2}-\d{2})/g)];
  const current = ranges[0] ? dateBounds(ranges[0][1], ranges[0][2])
    : dateBounds(String(body.date_from ?? ""), String(body.date_to ?? ""));
  const prior = ranges[1] ? dateBounds(ranges[1][1], ranges[1][2])
    : body.comparison_date_from || body.comparison_date_to
      ? dateBounds(String(body.comparison_date_from ?? ""), String(body.comparison_date_to ?? ""))
      : /对比|上周|变化/.test(question) ? priorBounds(current) : undefined;
  return { metric, scope, current, prior };
}

function reportRate(row: AppointmentCounts, metric: Rates) {
  const numerator = metric === "attendance_rate" ? row.attended : row.unprocessed;
  const denominator = row.attended + row.patient_cancelled + row.no_show + row.unprocessed;
  const availability = row.unclassified ? "MISSING" : denominator ? "AVAILABLE" : "NOT_APPLICABLE";
  return { numerator, denominator, availability, value: availability === "AVAILABLE" ? String(numerator / denominator) : null };
}

function reportMoney({ financial }: Report) {
  return { received: financial.received, refunded: financial.refunded, net_received: financial.net_received };
}

function changes(metric: Rates | "net_received", current: Report, prior: Report) {
  if (metric === "net_received") return [{ clinic_id: null,
    ...Object.fromEntries(moneyKeys.map(key => [key, (Number(current.financial[key]) - Number(prior.financial[key])).toFixed(2)])) }];

  return current.appointments.by_clinic.map(office => {
    const baseline = prior.appointments.by_clinic.find(row => row.clinic_id === office.clinic_id);
    const rate = reportRate(office, metric);
    const previous = baseline && reportRate(baseline, metric);
    if (previous && rate.value !== null && previous.value !== null) {
      return { clinic_id: office.clinic_id, percentage_points: ((Number(rate.value) - Number(previous.value)) * 100).toFixed(2) };
    }
    const availability = !previous || [rate.availability, previous.availability].includes("MISSING") ? "MISSING" : "NOT_APPLICABLE";
    return { clinic_id: office.clinic_id, percentage_points: null, availability };
  });
}

function guidance(metric: Metric, reports: Report[]) {
  const observations = (rules: Source[]) => rules.map(rule => ({ id: rule.id, text: rule.summary, source_id: rule.id }));
  if (metric === "deposit_refund" || metric === "report_rules") {
    const sources = metric === "deposit_refund" ? depositRules : [denominatorRule, attendanceRule];
    return { sources, observations: observations(sources), questions: [], next_steps: [] };
  }
  const changePeriod = { id: "change_period", label: "换一个期间" };
  if (metric === "net_received") {
    const period_index = reports.findIndex(report => Number(report.financial.received) || Number(report.financial.refunded));
    return { sources: [financialRule, financialScope], observations: observations([financialRule]),
      questions: [{ id: "receipt_timing", text: "需要解释波动时，可核对成功收退款的回执日期。" }],
      next_steps: [period_index === -1 ? changePeriod : { id: "money_breakdown", label: "查看收退构成", period_index }] };
  }
  const period_index = reports.findIndex(report => report.appointments.by_clinic.some(row => row.unprocessed > 0));
  const next_steps: { id: string; label: string; period_index?: number }[] = [];
  if (reports.some(report => report.appointments.by_clinic.some(row => reportRate(row, metric).value === null))) {
    next_steps.push(changePeriod);
  }
  if (metric === "unprocessed" && period_index >= 0) {
    next_steps.push({ id: "unprocessed_details", label: "查看同范围异常明细", period_index });
  }
  next_steps.push({ id: "report_rules", label: "查看统计口径" });
  return { sources: [denominatorRule, attendanceRule], observations: observations([metric === "unprocessed" ? denominatorRule : attendanceRule]),
    questions: [{ id: "unprocessed_reason", text: "要解释到期未处置的原因，可由门店核实排班和签到情况。" }], next_steps };
}

export function createSampleAssistant() {
  const results = new Map<string, { result: unknown; reports: Report[] }>();
  const actions = new Map<string, string>();

  return function sampleAssistant(suffix: string, method: string, query: URLSearchParams, body: Body,
    report: (query: URLSearchParams) => unknown, actionKey?: string): unknown {
    if (method === "GET" && suffix === "/suggestions") return suggestions(query);
    if (method === "GET" && suffix === "/report") {
      const reference = query.get("reference")?.match(/^([a-f0-9]{32}):([01])$/);
      const target = reference && results.get(reference[1])?.reports[Number(reference[2])];
      if (!target) problem(400, "VALIDATION_ERROR", "报告引用无效，请重新分析。");
      return { ...target, original_as_of: target.as_of, snapshot_refreshed: false };
    }
    if (method === "GET" && (suffix === "/analysis" || suffix === "/analysis/by-action")) {
      const id = suffix === "/analysis" ? query.get("analysis_id") : actions.get(actionKey ?? "");
      if (suffix === "/analysis/by-action" && !id) problem(404, "NOT_FOUND", "尚未找到原分析请求。");
      const stored = results.get(id ?? "");
      if (!stored) problem(409, "RESULT_EXPIRED", "本次分析已失效，请重新分析。");
      return stored.result;
    }
    if (method !== "POST" || suffix !== "/analysis") return undefined;

    const { metric, scope, current, prior } = interpretation(body);
    const analysis_id = crypto.randomUUID().replaceAll("-", "");
    const reports: Report[] = [], periods = [];
    let comparison = null;
    if (metric !== "deposit_refund" && metric !== "report_rules") {
      for (const [index, bounds] of (prior ? [current, prior] : [current]).entries()) {
        const params = new URLSearchParams(bounds);
        if (scope.clinic_ids.length < clinicIds.length) params.set("clinic_ids", scope.clinic_ids.join(","));
        if (scope.dentist_ids.length) params.set("dentist_ids", scope.dentist_ids.join(","));
        const snapshot = report(params) as Report;
        reports.push(snapshot);
        const { date_from, date_to, as_of, scope: reportScope } = snapshot;
        const metrics = metric === "net_received" ? [{ clinic_id: null, ...reportMoney(snapshot) }]
          : snapshot.appointments.by_clinic.map(row => ({ clinic_id: row.clinic_id, [metric]: reportRate(row, metric) }));
        periods.push({ date_from, date_to, as_of, scope: reportScope, reference: analysis_id + ":" + index, metrics });
      }
      if (reports.length === 2) comparison = { changes: changes(metric, reports[0], reports[1]) };
    }
    const result = { analysis_id, metric, ...current, as_of: reports[0]?.as_of ?? sampleCutoff,
      scope: reports[0]?.scope ?? scope, periods, comparison,
      ...guidance(metric, reports), mode: "template", model_status: "disabled" };
    results.set(analysis_id, { result, reports });
    if (actionKey) actions.set(actionKey, analysis_id);
    return result;
  };
}
