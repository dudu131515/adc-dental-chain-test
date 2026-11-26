import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PagesDemo } from "../demo/PagesDemo";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

test("Pages uses the staff product shell and formal calendar at the legacy public link without network", async () => {
  window.history.replaceState({}, "", "/adc-demo/?release=qa#desk/calendar");
  const network = vi.fn(() => { throw new Error("演示不能访问网络"); });
  vi.stubGlobal("fetch", network);
  render(<PagesDemo />);
  expect(await screen.findByRole("heading", {name:"排班与预约"})).toBeTruthy();
  const navigation = screen.getByRole("navigation", {name:"业务导航"});
  expect(within(navigation).getByRole("link", {name:"预约日历"}).getAttribute("href")).toBe("#/schedule?view=appointments");
  expect(await screen.findByRole("region", {name:"林明远"})).toBeTruthy();
  expect(window.location.pathname).toBe("/adc-demo/");
  expect(window.location.search).toBe("?release=qa");
  expect(network).not.toHaveBeenCalled();
});
