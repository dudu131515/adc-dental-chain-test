import { expect, test } from "vitest";
import { createSampleAssistant } from "../demo/sampleAssistant";
import { dailyFacts, offices, sumFacts } from "../demo/fixtures";

const dates = { date_from: "2026-11-24", date_to: "2026-11-26" };
const query = new URLSearchParams(dates);

function report(query: URLSearchParams) {
  const date_from = query.get("date_from")!;
  const date_to = query.get("date_to")!;
  const clinic_ids = query.get("clinic_ids")?.split(",") ?? offices;
  const facts = dailyFacts.filter(row =>
    clinic_ids.includes(row.clinic) && "2026-" + row.day >= date_from && "2026-" + row.day <= date_to);
  const total = sumFacts(facts);
  return {
    date_from, date_to, as_of: "2026-11-30T20:00:00+08:00",
    scope: { clinic_ids, dentist_ids: [] },
    report_token: "report-" + date_from,
    appointments: {
      by_clinic: clinic_ids.map(clinic_id => {
        const fact = sumFacts(facts.filter(row => row.clinic === clinic_id));
        return { clinic_id, attended: fact.arrived, unprocessed: fact.unresolved,
          no_show: fact.total - fact.arrived - fact.unresolved, patient_cancelled: 0 };
      }),
    },
    financial: { received: total.net.toFixed(2), refunded: "0.00", net_received: total.net.toFixed(2) },
  };
}

test("the clinic attendance suggestion compares the same facts as both original reports", () => {
  const assistant = createSampleAssistant();
  const result = assistant("/analysis", "POST", query, { ...dates, question: "对比两店实际就诊率",
    comparison_date_from: "2026-11-17", comparison_date_to: "2026-11-19" }, report);
  expect(result).toMatchObject({
    metric: "attendance_rate", mode: "template", model_status: "disabled",
    comparison: { changes: [
      { clinic_id: "central", percentage_points: "-25.00" },
      { clinic_id: "river", percentage_points: "25.00" },
    ] },
  });
  const { periods } = result as { periods: { reference: string }[] };
  expect(periods).toHaveLength(2);
  for (const [index, period] of periods.entries()) {
    const original = assistant("/report", "GET", new URLSearchParams({ reference: period.reference }), {}, () => {
      throw new Error("The original report must come from the analysis snapshot.");
    });
    expect(original).toMatchObject({
      date_from: index === 0 ? "2026-11-24" : "2026-11-17",
      report_token: index === 0 ? "report-2026-11-24" : "report-2026-11-17",
      scope: { clinic_ids: ["central", "river"] },
    });
  }
});

test("a net receipts suggestion compares the selected clinic with the corresponding prior week", () => {
  const assistant = createSampleAssistant();
  const filters = new URLSearchParams({ ...dates, clinic_ids: "river" });
  const { suggestions } = assistant("/suggestions", "GET", filters, {}, report) as {
    suggestions: { id: string; selection: Record<string, unknown> }[];
  };
  const { selection } = suggestions.find(suggestion => suggestion.id === "net_received")!;
  const result = assistant("/analysis", "POST", query, selection, report);
  expect(result).toMatchObject({
    metric: "net_received", scope: { clinic_ids: ["river"] },
    comparison: { changes: [{ clinic_id: null, net_received: "40.00" }] },
    next_steps: [{ id: "money_breakdown", period_index: 0 }],
  });
});

test("a completed analysis is recoverable using its original action key", () => {
  const assistant = createSampleAssistant();
  const action = "c62206fa-48a0-4f61-a536-6c84bef89d6e";
  const result = assistant("/analysis", "POST", query, { ...dates, metric: "unprocessed" }, report, action);
  expect(assistant("/analysis/by-action", "GET", query, {}, report, action)).toEqual(result);
  expect(result).toMatchObject({ next_steps: expect.arrayContaining([{ id: "unprocessed_details",
    label: "查看同范围异常明细", period_index: 0 }]) });
});

test("a policy question returns sourced rules without querying appointment or financial data", () => {
  const assistant = createSampleAssistant();
  const result = assistant("/analysis", "POST", query, { ...dates, question: "查询预约金退还规则" }, () => {
    throw new Error("Policy responses do not depend on report data.");
  });
  expect(result).toMatchObject({
    metric: "deposit_refund", periods: [], comparison: null,
    sources: expect.arrayContaining([{ id: "FR-208", title: "预约金取消与退还",
      summary: expect.stringContaining("满 24 小时全退"), version: expect.any(String) }]),
  });
});

test("an unrecognized prompt asks for a selection and empty rates stay inapplicable", () => {
  const assistant = createSampleAssistant();
  expect(() => assistant("/analysis", "POST", query, { ...dates, question: "经营情况如何？" }, report))
    .toThrow("请通过选项补全门店、统计期间和指标。");
  expect(assistant("/analysis", "POST", query, { metric: "attendance_rate",
    date_from: "2026-11-01", date_to: "2026-11-02",
    comparison_date_from: dates.date_from, comparison_date_to: dates.date_to }, report)).toMatchObject({
    comparison: { changes: [
      { clinic_id: "central", percentage_points: null, availability: "NOT_APPLICABLE" },
      { clinic_id: "river", percentage_points: null, availability: "NOT_APPLICABLE" },
    ] },
  });
});
