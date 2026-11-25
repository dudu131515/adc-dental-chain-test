import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { VisitDetail } from "../src/features/clinical/VisitDetail";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a billing projection does not display clinical details or actions", async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (!path.endsWith("/visits/21")) throw new Error("unexpected request " + path);
    return new Response(JSON.stringify({ data: {
      visit_id: "21", appointment_id: "15", appointment_no: "ADC-SCOPE", status: "IN_PROGRESS",
      started_at: "2030-10-17T11:00:00+08:00", chair: null, treatment_items: [], estimated_amount: "0.00",
    } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<VisitDetail id="21" open={() => {}} />);
  expect(await screen.findByText("仅负责本次就诊的牙医可查看诊疗详情。")).toBeTruthy();
  expect(screen.queryByText("结束诊疗")).toBeNull();
  expect(screen.queryByText("本次治疗")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
