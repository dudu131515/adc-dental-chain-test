import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PagesDemo } from "../demo/PagesDemo";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

test("store and schedule filters lead to synthetic appointment evidence", () => {
  render(<PagesDemo />);
  expect(screen.getByRole("heading", {name:"运营首页"})).toBeTruthy();
  expect(screen.queryByRole("heading", {name:"预约日程"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"门诊运营"}));
  fireEvent.click(screen.getByRole("link", {name:"预约日历"}));
  fireEvent.click(screen.getByRole("button", {name:"列表"}));
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
  fireEvent.click(screen.getByRole("button", {name:"经营与配置"}));
  fireEvent.click(screen.getByRole("link", {name:"经营概览"}));
  expect(screen.getByRole("heading", {name:"经营概览"})).toBeTruthy();
  expect(screen.queryByRole("button", {name:"发送"})).toBeNull();
  fireEvent.click(screen.getByRole("link", {name:"AI 分析"}));
  fireEvent.click(screen.getByRole("button", {name:"对比两店实际就诊率"}));
  expect(screen.queryByText("−25 个百分点")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"发送"}));
  expect(screen.getByText("−25 个百分点")).toBeTruthy();
  expect(screen.getByText("+25 个百分点")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"查看原报表"}));
  const source = screen.getByRole("region", {name:"两期样例统计"});
  expect(within(source).getByText("4 / 8")).toBeTruthy();
  expect(within(source).getByText("2 / 4")).toBeTruthy();
});

test("the time chart filters the agenda and date changes refresh the same ledger", () => {
  render(<PagesDemo />);
  fireEvent.click(screen.getByRole("button", {name:"门诊运营"}));
  fireEvent.click(screen.getByRole("link", {name:"预约趋势"}));
  fireEvent.click(screen.getByRole("button", {name:"16 时，1 笔预约"}));
  expect(screen.queryByRole("button", {name:/陈晓雨/})).toBeNull();
  expect(screen.getByRole("button", {name:/许言/})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"清除筛选"}));
  expect(screen.getByRole("button", {name:/陈晓雨/})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"收费与日结"}));
  fireEvent.click(screen.getByRole("link", {name:"日结对账"}));
  expect(screen.getByText(/当前在途.*30\.00/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("流水状态"), {target:{value:"pending"}});
  expect(screen.getByText("诊疗收款在途")).toBeTruthy();
  expect(screen.queryByText("诊疗已退")).toBeNull();
  fireEvent.change(screen.getByLabelText("业务日期"), {target:{value:"2026-11-26"}});
  expect(screen.getByText("所选门店和日期没有模拟资金记录。")).toBeTruthy();
});

test("home and four expandable groups show the matching route on deep links", () => {
  window.history.replaceState({}, "", "/#operations/ai");
  render(<PagesDemo />);
  const categories = screen.getByRole("navigation", {name:"业务导航"});
  expect(within(categories).getAllByRole("button")).toHaveLength(4);
  expect(within(categories).getByRole("link", {name:"首页"})).toBeTruthy();
  expect(within(categories).getByRole("button", {name:"经营与配置"}).getAttribute("aria-expanded")).toBe("true");
  const tabs = screen.getByRole("list", {name:"经营与配置子功能"});
  expect(within(tabs).getByRole("link", {name:"AI 分析"}).getAttribute("aria-current")).toBe("page");
  fireEvent.click(within(tabs).getByRole("link", {name:"门店对比"}));
  expect(window.location.hash).toBe("#operations/compare");
  expect(screen.getByRole("heading", {name:"两店样例指标"})).toBeTruthy();
  act(() => {
    window.history.replaceState({}, "", "/#operations/overview");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByRole("heading", {name:"经营概览"})).toBeTruthy();
  expect(screen.getByRole("link", {name:"经营概览"}).getAttribute("aria-current")).toBe("page");
});

test("schedule resources and the financial queue expose actual linked records", () => {
  render(<PagesDemo />);
  fireEvent.click(screen.getByRole("button", {name:"门诊运营"}));
  fireEvent.click(screen.getByRole("link", {name:"预约日历"}));
  fireEvent.click(screen.getByRole("button", {name:"按牙椅"}));
  const board=screen.getByRole("region", {name:"预约排程"});
  expect(within(board).getByText("A-01")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"收费与日结"}));
  fireEvent.click(screen.getByRole("link", {name:"账单与收退"}));
  fireEvent.click(screen.getByRole("button", {name:"查看 ADC-DEMO-INV-120"}));
  const bill=screen.getByRole("dialog", {name:"预约详情"});
  expect(within(bill).getByRole("heading", {name:"诊疗费用单"})).toBeTruthy();
  expect(within(bill).getByText(/100\.00/)).toBeTruthy();
});

test("operating trends change with the period and selected clinic", () => {
  window.history.replaceState({}, "", "/#operations/overview");
  render(<PagesDemo />);
  const trends=screen.getByRole("region", {name:"日常经营趋势"});
  fireEvent.change(screen.getByLabelText("门店"), {target:{value:"central"}});
  fireEvent.change(within(trends).getByLabelText("统计期间"), {target:{value:"previous"}});
  expect(within(trends).getByText("11-17")).toBeTruthy();
  expect(within(trends).queryByText("滨江口腔门诊")).toBeNull();
  fireEvent.click(within(trends).getByRole("button", {name:"诊疗净实收"}));
  expect(within(trends).getByText(/100\.00/)).toBeTruthy();
});

test("patient detail tabs retain a patient's historical invoice and allergy evidence", () => {
  window.history.replaceState({}, "", "/#patients/directory");
  render(<PagesDemo />);
  fireEvent.click(screen.getByRole("button", {name:"查看 陈晓雨 预约详情"}));
  const detail=screen.getByRole("dialog", {name:"预约详情"});
  expect(within(detail).getByText("ADC-DEMO-011")).toBeTruthy();
  fireEvent.click(within(detail).getByRole("button", {name:"过敏核对"}));
  expect(within(detail).getByText("乳胶")).toBeTruthy();
  fireEvent.click(within(detail).getByRole("button", {name:"费用单"}));
  expect(within(detail).getByText(/ADC-DEMO-INV-120/)).toBeTruthy();
});

test("the demo assistant keeps two textual turns and offers evidence links", () => {
  window.history.replaceState({}, "", "/#operations/ai");
  render(<PagesDemo />);
  const composer=screen.getByRole("textbox", {name:"经营问题"});
  fireEvent.click(screen.getByRole("button", {name:"对比两店实际就诊率"}));
  expect((composer as HTMLTextAreaElement).value).toBe("对比两店实际就诊率");
  fireEvent.click(screen.getByRole("button", {name:"发送"}));
  fireEvent.change(composer,{target:{value:"那诊疗净实收呢？"}});
  fireEvent.click(screen.getByRole("button", {name:"发送"}));
  const conversation=screen.getByRole("log", {name:"经营对话"});
  expect(within(conversation).getByText("−25 个百分点")).toBeTruthy();
  expect(within(conversation).getByText("那诊疗净实收呢？")).toBeTruthy();
  expect(within(conversation).getByText("+40 元")).toBeTruthy();
});
