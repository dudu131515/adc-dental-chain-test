import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AllergySection } from "./AllergyReview";
import { ClinicalContext } from "./clinicalTypes";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const context: ClinicalContext = {
  appointment: {
    appointment_id: "9", appointment_no: "SYN-9", claim_id: "22", status: "CHECKED_IN", is_attended: false,
    clinic: { clinic_id: "1", name: "合成门店", address: "" }, dentist: { dentist_id: "1", name: "合成牙医" },
    treatment: { treatment_type_id: "1", name: "检查" }, start_at: "", end_at: "", allowed_actions: [],
  },
  allergies: [], allergy_review: { status: "UNVERIFIED", version: "0", history: [] },
  chair: null, special_requirement: null, history: [],
};

test("a blank chart needs an explicit patient confirmation before saving no known allergies", async () => {
  const reload = vi.fn();
  const fetcher = vi.fn(async (path: string, _options: RequestInit) =>
    Response.json({ data: path.endsWith("/csrf") ? { csrf_token: "synthetic-csrf" } : { review_id: "1" } }));
  vi.stubGlobal("fetch", fetcher);
  render(<AllergySection context={context} onReload={reload} />);
  expect(screen.getByText("未核实")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "核对或更新过敏史" }));
  const save = screen.getByRole("button", { name: "确认并保存核对结果" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("核对结果"), { target: { value: "NONE_KNOWN" } });
  fireEvent.click(save);
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  const call = fetcher.mock.calls.find(([url]) => url.endsWith("/appointments/9/allergy-reviews"));
  expect(JSON.parse(String(call?.[1].body))).toEqual({
    expected_claim_id: "22", expected_version: "0", status: "NONE_KNOWN", allergies: [],
  });
  expect((call?.[1].headers as Headers).get("Idempotency-Key")).toBeTruthy();
});

test("a stale draft keeps its original version and offers a reload after a concurrent edit", async () => {
  const reload = vi.fn();
  const fetcher = vi.fn(async (path: string, _options: RequestInit) => path.endsWith("/csrf")
    ? Response.json({ data: { csrf_token: "synthetic-csrf" } })
    : Response.json({ error: { code: "STALE_ALLERGY_REVIEW", message: "患者资料已更新" } }, { status: 409 }));
  vi.stubGlobal("fetch", fetcher);
  const chart: ClinicalContext = { ...context, allergies: [{ allergen: "合成甲", notes: "原备注" }],
    allergy_review: { version: "7", history: [], status: "KNOWN" } };
  const view = render(<AllergySection context={chart} onReload={reload} />);
  fireEvent.click(screen.getByRole("button", { name: "核对或更新过敏史" }));
  fireEvent.change(screen.getByLabelText("反应或备注 1（选填）"), { target: { value: "更新备注" } });
  view.rerender(<AllergySection context={{ ...chart, allergy_review: { ...chart.allergy_review, version: "8" } }}
    onReload={reload} />);
  fireEvent.click(screen.getByRole("button", { name: "确认并保存核对结果" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "患者资料已更新");
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1].body))).toMatchObject({
    expected_version: "7", allergies: [{ allergen: "合成甲", notes: "更新备注" }],
  });
  fireEvent.click(screen.getByRole("button", { name: "放弃本次编辑并重新读取" }));
  expect(reload).toHaveBeenCalledOnce();
});
