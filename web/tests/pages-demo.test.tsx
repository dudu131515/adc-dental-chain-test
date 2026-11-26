import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PagesDemo } from "../demo/PagesDemo";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

test("store and schedule filters lead to synthetic appointment evidence", () => {
  render(<PagesDemo />);
  expect(screen.getByRole("heading", {name:"门诊工作台"})).toBeTruthy();
  expect(screen.getByText("合成演示")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("门店"), {target:{value:"river"}});
  expect(screen.queryByRole("button", {name:/陈晓雨/})).toBeNull();
  fireEvent.change(screen.getByLabelText("门店"), {target:{value:"central"}});
  fireEvent.click(screen.getByRole("button", {name:/许言/}));
  const detail = screen.getByRole("dialog", {name:"预约详情"});
  expect(within(detail).getByText("青霉素")).toBeTruthy();
  expect(within(detail).getByText("ADC-DEMO-010")).toBeTruthy();
  fireEvent.click(within(detail).getByRole("button", {name:"关闭详情"}));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the operating report previews a selected analysis and links to the same source data", () => {
  render(<PagesDemo />);
  fireEvent.click(screen.getByRole("link", {name:"经营分析"}));
  fireEvent.click(screen.getByRole("button", {name:"对比两店实际就诊率"}));
  expect(screen.queryByText("−25 个百分点")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"查看分析"}));
  expect(screen.getByText("−25 个百分点")).toBeTruthy();
  expect(screen.getByText("+25 个百分点")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"查看原报表"}));
  const source = screen.getByRole("region", {name:"两期样例统计"});
  expect(within(source).getByText("4 / 8")).toBeTruthy();
  expect(within(source).getByText("2 / 4")).toBeTruthy();
});

test("the time chart filters the agenda and date changes refresh the same ledger", () => {
  render(<PagesDemo />);
  fireEvent.click(screen.getByRole("button", {name:"16 时，1 笔预约"}));
  expect(screen.queryByRole("button", {name:/陈晓雨/})).toBeNull();
  expect(screen.getByRole("button", {name:/许言/})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"清除筛选"}));
  expect(screen.getByRole("button", {name:/陈晓雨/})).toBeTruthy();
  fireEvent.click(screen.getByRole("link", {name:"收费与日结"}));
  expect(screen.getByText(/当前在途.*30\.00/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("业务日期"), {target:{value:"2026-11-26"}});
  expect(screen.getByText("所选门店和日期没有模拟资金记录。")).toBeTruthy();
});
