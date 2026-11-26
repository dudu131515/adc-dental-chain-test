import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { OperationsPage } from "../src/features/operations/OperationsPage";
import { OperationsReport } from "../src/features/operations/OperationsReport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const identity = {
  account_id: "8", category: "staff" as const, employee_id: "8", capabilities: ["HQ_OPERATIONS_QUERY"],
  clinics: [{ clinic_id: "1", name: "合成甲店" }, { clinic_id: "2", name: "合成乙店" }],
};
const selection = {
  metric: "attendance_rate", clinic_ids: ["1", "2"], dentist_ids: [], date_from: "2030-10-15", date_to: "2030-10-16",
  comparison_date_from: "2030-10-08", comparison_date_to: "2030-10-09",
};
const cutoff = "2030-10-16T17:00:00+08:00";

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

test("assistant suggestions fill editable filters and only an explicit submission analyzes them", async () => {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (path.endsWith("/csrf")) return response({ csrf_token: "demo" });
    if (path.includes("/suggestions?")) return response({ clinics: identity.clinics,
      suggestions: [{ id: "weekly_attendance", label: "对比两店本周与上周的实际就诊率", selection }],
    });
    if (path.endsWith("/analysis")) return response({
      analysis_id: "demo", metric: "attendance_rate", mode: "template", model_status: "disabled",
      periods: [{ date_from: selection.date_from, date_to: selection.date_to, as_of: cutoff,
        scope: { clinic_ids: ["1"], dentist_ids: [] }, reference: "signed-current", metrics: [{
          clinic_id: "1", attendance_rate: { numerator: 0, denominator: 0, availability: "NOT_APPLICABLE", value: null },
        }],
      }], comparison: null, sources: [], next_steps: [],
      observations: [{ id: "attendance", text: "按正式预约口径核对实际就诊率。" }], questions: [],
    });
    if (path.includes("/assistant/report?")) {
      const counts = { attended: 0, patient_cancelled: 0, no_show: 0, unprocessed: 1, clinic_cancelled: 0 };
      const rate = { numerator: 0, denominator: 1, value: "0", availability: "AVAILABLE" };
      return response({
        date_from: selection.date_from, date_to: selection.date_to, as_of: cutoff, report_token: "same-token",
        snapshot_refreshed: false, original_as_of: cutoff, scope: { clinic_ids: ["1"], dentist_ids: [] }, sources: {},
        appointments: { ...counts, denominator: 1, attendance_rate: rate, cancellation_rate: rate,
          by_clinic: [{ ...counts, clinic_id: "1" }] },
        clinical: { actual_starts: 0, actual_treatments: 0, normal_completions: 0 }, standard_coverage: rate,
        financial: { accrued: "0.00", received: "0.00", refunded: "0.00", net_received: "0.00", outstanding: "0.00" },
        skills: [], performance: [],
      });
    }
    if (path.includes("/details?")) return response({ as_of: cutoff, total: 1, next_cursor: null,
      items: [{ appointment_no: "ADC-ASSISTANT-SNAPSHOT", status: "CHECKED_IN" }],
    });
    throw new Error("unexpected request " + path);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<OperationsReport identity={identity} clinicId="1" open={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "经营分析助手" }));
  fireEvent.click(await screen.findByRole("button", { name: "对比两店本周与上周的实际就诊率" }));
  expect((screen.getByLabelText("本期开始") as HTMLInputElement).value).toBe("2030-10-15");
  fireEvent.change(screen.getByLabelText("本期开始"), { target: { value: "2030-10-14" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "合成乙店" }));
  expect(fetcher.mock.calls.map(([path]) => path).every(path => path.includes("/suggestions?"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
  expect(await screen.findByText("按正式预约口径核对实际就诊率。")).toBeTruthy();
  const submission = fetcher.mock.calls.find(([path]) => path.endsWith("/analysis"));
  expect(JSON.parse(submission?.[1].body as string)).toEqual({ ...selection, date_from: "2030-10-14", clinic_ids: ["1"] });
  expect(screen.getByText("不适用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看原报表" }));
  fireEvent.click(await screen.findByRole("button", { name: "合成甲店 到期未处置 1" }));
  expect(await screen.findByText("ADC-ASSISTANT-SNAPSHOT")).toBeTruthy();
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("report_token=same-token&metric=unprocessed&clinic_id=1");
});

test("a lost analysis response recovers the original action key after reopening the panel", async () => {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (path.endsWith("/csrf")) return response({ csrf_token: "demo" });
    if (path.includes("/suggestions?")) return response({ clinics: identity.clinics,
      suggestions: [{ id: "unprocessed", label: "查询待处置", selection: { ...selection, metric: "unprocessed" } }],
    });
    if (path.endsWith("/analysis")) throw new TypeError("simulated lost analysis response");
    if (path.endsWith("/analysis/by-action")) return response({
      analysis_id: "demo", metric: "unprocessed", mode: "template", model_status: "disabled", as_of: cutoff,
      periods: [], comparison: null, sources: [], next_steps: [],
      observations: [{ id: "original", text: "已恢复原分析结果。" }], questions: [],
    });
    throw new Error("unexpected request " + path);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<OperationsReport identity={identity} clinicId="1" open={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "经营分析助手" }));
  await screen.findByRole("button", { name: "查询待处置" });
  fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
  await screen.findByRole("button", { name: "核对原分析结果" });
  fireEvent.click(screen.getByRole("button", { name: "经营分析助手" }));
  fireEvent.click(screen.getByRole("button", { name: "经营分析助手" }));
  fireEvent.click(await screen.findByRole("button", { name: "核对原分析结果" }));
  expect(await screen.findByText("已恢复原分析结果。")).toBeTruthy();
  const posts = fetcher.mock.calls.filter(([path]) => path.endsWith("/analysis"));
  const lookups = fetcher.mock.calls.filter(([path]) => path.endsWith("/analysis/by-action"));
  expect(posts).toHaveLength(1);
  expect(lookups).toHaveLength(1);
  const key = (posts[0][1].headers as Headers).get("Idempotency-Key");
  expect(key).toBeTruthy();
  expect((lookups[0][1].headers as Headers).get("Idempotency-Key")).toBe(key);
});

test("suggested follow-up opens eligible comparison-period details", async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (path.endsWith("/csrf")) return response({ csrf_token: "demo" });
    if (path.includes("/suggestions?")) return response({ clinics: identity.clinics,
      suggestions: [{ id: "unprocessed", label: "查询待处置", selection: { ...selection, metric: "unprocessed" } }],
    });
    if (path.endsWith("/analysis")) {
      const period = (reference: string, date_from: string) => ({ reference, date_from, date_to: date_from, as_of: cutoff,
        scope: { clinic_ids: ["1"], dentist_ids: [] }, metrics: [],
      });
      return response({
        analysis_id: "demo", metric: "unprocessed", mode: "template", model_status: "disabled", as_of: cutoff,
        periods: [period("signed-current", "2030-10-16"), period("signed-prior", "2030-10-09")],
        comparison: { changes: [{ clinic_id: "1", percentage_points: null, availability: "MISSING" }] },
        sources: [], observations: [], questions: [],
        next_steps: [{ id: "unprocessed_details", label: "查看同范围异常明细", period_index: 1 }],
      });
    }
    if (path.includes("/assistant/report?")) {
      const counts = { attended: 0, patient_cancelled: 0, no_show: 0, unprocessed: 1, clinic_cancelled: 0 };
      const rate = { numerator: 0, denominator: 1, value: "0", availability: "AVAILABLE" };
      return response({
        date_from: "2030-10-09", date_to: "2030-10-09", as_of: cutoff, report_token: "prior-token",
        snapshot_refreshed: false, original_as_of: cutoff, scope: { clinic_ids: ["1"], dentist_ids: [] }, sources: {},
        appointments: { ...counts, denominator: 1, attendance_rate: rate, cancellation_rate: rate, by_clinic: [] },
        clinical: { actual_starts: 0, actual_treatments: 0, normal_completions: 0 }, standard_coverage: rate,
        financial: { accrued: "0.00", received: "0.00", refunded: "0.00", net_received: "0.00", outstanding: "0.00" },
        skills: [], performance: [],
      });
    }
    if (path.includes("/details?")) return response({ as_of: cutoff, total: 1, next_cursor: null,
      items: [{ appointment_no: "PRIOR-PERIOD-EVIDENCE", status: "CHECKED_IN" }],
    });
    throw new Error("unexpected request " + path);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<OperationsReport identity={identity} clinicId="1" open={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "经营分析助手" }));
  await screen.findByRole("button", { name: "查询待处置" });
  fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
  expect(await screen.findByText("缺少数据")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看同范围异常明细" }));
  expect(await screen.findByText("PRIOR-PERIOD-EVIDENCE")).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => path.includes("reference=signed-prior"))).toBe(true);
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("report_token=prior-token&metric=unprocessed");
});

test("the standalone assistant sends typed text to Django and renders a conversation", async () => {
  const fetcher=vi.fn(async (path:string, options:RequestInit) => {
    if (path.endsWith("/csrf")) return response({csrf_token:"demo"});
    if (path.includes("/suggestions?")) return response({clinics:identity.clinics,
      suggestions:[{id:"weekly_attendance",label:"对比两店就诊率",selection}]});
    if (path.endsWith("/analysis")) return response({
      analysis_id:"workspace-1",metric:"attendance_rate",mode:"deepseek",model_status:"success",as_of:cutoff,
      periods:[],comparison:null,sources:[],questions:[],next_steps:[],
      observations:[{id:"o",text:"Django 授权分析已返回"}],
    });
    throw new Error(path);
  });
  vi.stubGlobal("fetch",fetcher);
  render(<OperationsPage identity={identity} clinicId="" path="/operations/assistant" section="/operations" open={()=>{}}/>);
  await screen.findByRole("button",{name:"对比两店就诊率"});
  fireEvent.change(screen.getByRole("textbox",{name:"经营问题"}),{target:{value:"查看实际就诊率"}});
  fireEvent.click(screen.getByRole("button",{name:"发送"}));
  expect(await screen.findByText("Django 授权分析已返回")).toBeTruthy();
  expect(JSON.parse(String(fetcher.mock.calls.find(([path])=>path.endsWith("/analysis"))?.[1].body)).question).toBe("查看实际就诊率");
  expect(screen.getByRole("log",{name:"经营对话"})).toBeTruthy();
});
