import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BillingPage } from "../src/features/billing/BillingPage";
import type { WorkArea } from "../src/shared/AppShell";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("the queue searches on the server and maintains the same search on the next page", async () => {
  const calls: { url: URL; query: string }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input, window.location.origin);
    const query = decodeURIComponent(new Headers(init.headers).get("X-ADC-Queue-Search") || "");
    calls.push({ url, query });
    const next = url.searchParams.get("cursor");
    const status = url.searchParams.get("status");
    return new Response(JSON.stringify({ data: {
      items: query && status === "WAITING_PAYMENT" ? [{
        visit_id: next ? "12" : "13", appointment_no: next ? "ADC-12" : "ADC-13", clinic_id: "1", clinic_name: "合成门店",
        ended_at: "2035-06-04T09:00:00+08:00", status: "COMPLETED", invoice_id: "7", invoice_no: "INV-SYNTHETIC",
        patient_display: { name: "合成患者", phone_tail: "0088" }, billing_state: "WAITING_PAYMENT",
        outstanding: "86.00", refund_remaining: "0.00", pending_refund: "0.00",
      }] : [],
      next_cursor: query && !next ? "page-2" : null,
    }}));
  });
  const area: WorkArea = {
    section: "/billing", path: "/billing", clinicId: "1", open: vi.fn(),
    identity: { account_id: "2", employee_id: "2", category: "staff", clinics: [{ clinic_id: "1", name: "合成门店" }],
      capabilities: ["FRONT_DESK"], role_clinic_ids: { FRONT_DESK: ["1"] } },
  };
  render(<BillingPage {...area} />);
  fireEvent.change(screen.getByRole("searchbox", {name:"搜索结算记录"}), {target:{value:"00000000088"}});
  fireEvent.change(screen.getByLabelText("办理状态"), {target:{value:"WAITING_PAYMENT"}});
  fireEvent.click(screen.getByRole("button",{name:"搜索",exact:true}));
  expect(await screen.findByText("ADC-13")).toBeTruthy();
  expect(screen.queryByText("00000000088")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"下一页"}));
  expect(await screen.findByText("ADC-12")).toBeTruthy();
  await waitFor(() => expect(calls.at(-1)?.url.searchParams.get("cursor")).toBe("page-2"));
  expect(calls.at(-1)?.url.searchParams.get("clinic_id")).toBe("1");
  expect(calls.at(-1)?.url.searchParams.has("q")).toBe(false);
  expect(calls.at(-1)?.query).toBe("00000000088");
});
