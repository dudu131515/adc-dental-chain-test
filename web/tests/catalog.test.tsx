import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { CatalogPage } from "../src/features/catalog/CatalogPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("standard catalog shows the exact current price and the history of a selected project", async () => {
  vi.stubGlobal("fetch", async (input: string) => {
    const items = input.includes("/prices") ? [
      { price_id: "3", unit_price: "130.00", effective_from: "2030-07-01", effective_to: null },
      { price_id: "2", unit_price: "120.00", effective_from: "2030-01-01", effective_to: "2030-07-01" },
    ] : input.includes("/qualifications") ? [] : [{
      treatment_type_id: "4", treatment_code: "ADC-CHECK", treatment_name: "合成初诊检查",
      standard_unit: "次", required_qualification_id: null, default_slot_minutes: 30,
      required_chair_kind: null, active: true, current_unit_price: "130.00",
    }];
    return new Response(JSON.stringify({ data: { items } }), { status: 200 });
  });
  render(<CatalogPage />);
  expect(await screen.findByText("¥130.00")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "合成初诊检查" }));
  expect(await screen.findByText("¥120.00")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "价格版本" })).toBeTruthy();
});
