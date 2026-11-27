import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PagesDemo } from "../demo/PagesDemo";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

function open(hash: string, role = "front") {
  sessionStorage.setItem("adc:demo-identity", role);
  window.history.replaceState({}, "", "/adc-demo/#" + hash);
  render(<PagesDemo />);
}

test("the four standard roles are separated from special accounts and headquarters uses one workspace", async () => {
  open("home");
  const roles = await screen.findByRole("combobox", {name:"样例身份"});
  expect(within(roles).getAllByRole("option").map(option => option.textContent)).toEqual([
    "前台", "牙医", "诊所主管", "总部管理人员",
  ]);
  fireEvent.change(roles, {target:{value:"scheduler"}});
  const nav = await screen.findByRole("navigation", {name:"业务导航"});
  fireEvent.click(within(nav).getByRole("button", {name:/经营与配置/}));
  for (const name of ["经营总览", "项目与价格", "绩效管理"]) {
    expect(within(nav).getByRole("link", {name})).toBeTruthy();
  }
  expect(within(nav).queryByRole("link", {name:"员工与权限"})).toBeNull();
  expect(within(roles).queryByRole("option", {name:"系统管理员"})).toBeNull();
  fireEvent.click(screen.getByText("更多身份", {exact:true}));
  expect(screen.getByRole("button", {name:"系统管理员"})).toBeTruthy();
});

test("the same appointment form creates an appointment visible in its patient record", async () => {
  open("desk/calendar");
  const doctor = await screen.findByRole("region", {name:"林明远"});
  fireEvent.click(within(doctor).getByRole("button", {name:/16:30.*候选空档/}));
  const drawer = screen.getByRole("complementary", {name:"代办预约"});
  await within(drawer).findByRole("option", {name:"林明远"});
  expect((within(drawer).getByLabelText("牙医") as HTMLSelectElement).value).toBe("1");
  expect((within(drawer).getByLabelText("意向开始时间") as HTMLInputElement).value).toBe("16:30");
  fireEvent.change(within(drawer).getByLabelText("查找本店患者"), {target:{value:"赵青"}});
  fireEvent.click(within(drawer).getByRole("button", {name:"查找",exact:true}));
  fireEvent.click(await within(drawer).findByRole("button", {name:/赵青.*ADC-P/}));
  fireEvent.change(within(drawer).getByLabelText("主诊项目"), {target:{value:"1"}});
  fireEvent.click(within(drawer).getByRole("button", {name:"查询可约时段"}));
  fireEvent.click(await within(drawer).findByRole("button", {name:/16:30.*林明远/}));
  fireEvent.click(within(drawer).getByRole("button", {name:"确认临时占位"}));
  fireEvent.click(await within(drawer).findByRole("button", {name:"提交模拟预约金付款"}));
  const confirmed = await within(drawer).findByRole("button", {name:/查看正式预约 ADC-PREVIEW-/});
  const number = confirmed.textContent!.match(/ADC-PREVIEW-\d+/)![0];
  fireEvent.click(confirmed);
  const appointment = await screen.findByRole("complementary", {name:"预约详情"});
  await within(appointment).findByText(number);
  fireEvent.click(screen.getByRole("button", {name:/患者与诊疗/}));
  fireEvent.click(within(screen.getByRole("navigation", {name:"业务导航"})).getByRole("link", {name:"患者档案"}));
  fireEvent.click(await screen.findByRole("button", {name:/赵青/}));
  expect(await screen.findByText(new RegExp(number))).toBeTruthy();
});

test("formal billing search opens the selected sample invoice", async () => {
  open("billing/queue");
  fireEvent.change(await screen.findByRole("searchbox",{name:"搜索结算记录"}),{target:{value:"ADC-DEMO-002"}});
  fireEvent.change(screen.getByLabelText("办理状态"),{target:{value:"PARTIAL_PAYMENT"}});
  fireEvent.click(screen.getByRole("button",{name:"搜索",exact:true}));
  fireEvent.click(await screen.findByRole("button",{name:"查看 ADC-DEMO-INV-120"}));
  expect(await screen.findByRole("heading",{name:"ADC-DEMO-INV-120"})).toBeTruthy();
  expect(screen.getAllByText(/100\.00/).length).toBeGreaterThan(0);
  expect(screen.queryByText("ADC-DEMO-001",{exact:true})).toBeNull();
});

test("sample patient record presents continuous care and billing at a glance", async () => {
  open("patients");
  fireEvent.click(await screen.findByRole("button", {name:/陈晓雨/}));
  expect(await screen.findByRole("heading", {name:"连续服务概览"})).toBeTruthy();
  expect(screen.getByText("预约 2 笔")).toBeTruthy();
  expect(screen.getByText("就诊 1 次")).toBeTruthy();
  expect(screen.getByText("账单 1 张")).toBeTruthy();
  expect(screen.getByText("待收 ¥100.00")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:/查看就诊详情/}));
  expect(await screen.findByRole("heading", {name:"就诊摘要"})).toBeTruthy();
  expect(screen.getByText("洁牙护理 · 1.000 次")).toBeTruthy();
});

test("registration offers the existing chart before saving a same-name patient", async () => {
  open("patients");
  fireEvent.click(await screen.findByRole("button", {name:/登记新患者/}));
  fireEvent.change(screen.getByLabelText("患者姓名"), {target:{value:"陈晓雨"}});
  const match = await screen.findByRole("button", {name:/使用现有档案.*陈晓雨/});
  fireEvent.click(match);
  expect(await screen.findByRole("heading", {name:"连续服务概览"})).toBeTruthy();
  expect(screen.queryByRole("button", {name:"保存患者档案"})).toBeNull();
});

test("sample staff use the shared schedule to draft, accept and publish a shift", async () => {
  open("desk/staff","scheduler");
  const role=await screen.findByLabelText("样例身份");
  fireEvent.click(await screen.findByRole("button",{name:"拟排班次"}));
  const form=screen.getByRole("form",{name:"拟排班次"});
  fireEvent.change(within(form).getByLabelText("开始"),{target:{value:"2026-11-28T09:00"}});
  fireEvent.change(within(form).getByLabelText("结束"),{target:{value:"2026-11-28T11:00"}});
  fireEvent.click(within(form).getByRole("button",{name:"保存草案"}));
  fireEvent.click(await screen.findByRole("button",{name:"提交牙医确认"}));
  await screen.findByRole("button",{name:/09:00.*中心口腔门诊.*待牙医确认/});
  fireEvent.change(role,{target:{value:"dentist"}});
  fireEvent.click(await screen.findByRole("button",{name:/09:00.*中心口腔门诊.*待牙医确认/}));
  fireEvent.click(screen.getByRole("button",{name:"提交答复"}));
  await screen.findByRole("button",{name:/09:00.*中心口腔门诊.*已接受/});
  fireEvent.change(screen.getByLabelText("样例身份"),{target:{value:"scheduler"}});
  fireEvent.click(await screen.findByRole("button",{name:/09:00.*中心口腔门诊.*已接受/}));
  fireEvent.click(screen.getByLabelText("已与牙医核对跨店路线可行"));
  fireEvent.change(screen.getByLabelText("路线核验依据"),{target:{value:"合成跨店路线确认"}});
  fireEvent.click(screen.getByRole("button",{name:"复查并发布"}));
  expect(await screen.findByRole("button",{name:/09:00.*中心口腔门诊.*已发布/})).toBeTruthy();
});

test("sample administrator uses the formal access editor and the same directory updates", async () => {
  open("operations/access","admin");
  fireEvent.click(await screen.findByRole("button",{name:"陈晓前"}));
  fireEvent.change(screen.getByLabelText("授权门店"),{target:{value:"river"}});
  fireEvent.change(screen.getByLabelText("功能权限"),{target:{value:"FRONT_DESK"}});
  fireEvent.change(screen.getByLabelText("授权变更原因"),{target:{value:"滨江临时支援"}});
  fireEvent.click(screen.getByRole("button",{name:"授予权限"}));
  expect(await screen.findByText("门店授权已更新。")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", {name:"编辑岗位与所属门店"}));
  fireEvent.change(screen.getByLabelText("所属岗位",{exact:true}), {target:{value:"CLINIC_MANAGER"}});
  fireEvent.change(screen.getByLabelText("岗位资料变更原因"), {target:{value:"合成入职资料核验"}});
  fireEvent.click(screen.getByRole("button", {name:"保存岗位资料"}));
  expect(await screen.findByText("岗位与所属门店已更新。")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("样例身份"),{target:{value:"front"}});
  expect(await screen.findByRole("heading",{name:"连锁管理总览"})).toBeTruthy();
  expect((screen.getByLabelText("工作门店") as HTMLSelectElement).options).toHaveLength(3);
  expect(screen.queryByRole("button",{name:"授予权限"})).toBeNull();
  expect(screen.getByText(/ADC-E004 · 诊所主管/)).toBeTruthy();
  const nav = screen.getByRole("navigation", {name:"业务导航"});
  expect(within(nav).queryByRole("button", {name:"经营与配置"})).toBeNull();
});

test("sample resource edits follow the shared data between administrator and headquarters", async () => {
  open("operations/clinics", "admin");
  const clinic = within(await screen.findByRole("row", { name: /ADC-A01/ }));
  fireEvent.click(clinic.getByRole("button", { name: "编辑门店" }));
  const clinicEditor = within(screen.getByRole("dialog", { name: "编辑门店" }));
  fireEvent.change(clinicEditor.getByLabelText("门店名称"), { target: { value: "合成中心门诊" } });
  fireEvent.click(clinicEditor.getByRole("button", { name: "保存门店" }));
  await screen.findByRole("row", { name: /ADC-A01.*合成中心门诊/ });
  fireEvent.change(screen.getByLabelText("样例身份"), { target: { value: "scheduler" } });
  const workClinic = within(await screen.findByLabelText("工作门店"));
  expect(await workClinic.findByRole("option", { name: "合成中心门诊" })).toBeTruthy();

  const nav = within(screen.getByRole("navigation", { name: "业务导航" }));
  fireEvent.click(nav.getByRole("button", { name: "经营与配置" }));
  fireEvent.click(nav.getByRole("link", { name: "牙椅管理" }));
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "新增牙椅" });
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.click(add);
  const addEditor = within(screen.getByRole("dialog", { name: "新增牙椅" }));
  fireEvent.change(addEditor.getByLabelText("所属门店"), { target: { value: "central" } });
  fireEvent.change(addEditor.getByLabelText("牙椅编号"), { target: { value: "SYN-CHAIR" } });
  fireEvent.click(addEditor.getByRole("button", { name: "保存牙椅" }));
  const chair = within(await screen.findByRole("row", { name: /SYN-CHAIR.*合成中心门诊.*GENERAL.*可用/ }));
  fireEvent.click(chair.getByRole("button", { name: "编辑牙椅" }));
  const edit = within(screen.getByRole("dialog", { name: "编辑牙椅" }));
  fireEvent.change(edit.getByLabelText("使用状态"), { target: { value: "INACTIVE" } });
  fireEvent.click(edit.getByRole("button", { name: "保存牙椅" }));
  await screen.findByRole("row", { name: /SYN-CHAIR.*合成中心门诊.*GENERAL.*停用/ });

  fireEvent.click(nav.getByRole("link", { name: "牙医资质" }));
  const credential = within(await screen.findByRole("row", { name: /林明远.*口腔执业医师/ }));
  fireEvent.click(credential.getByRole("button", { name: "编辑牙医资质" }));
  const credentialEditor = within(screen.getByRole("dialog", { name: "编辑牙医资质" }));
  fireEvent.change(credentialEditor.getByLabelText("证书编号"), { target: { value: "SYN-CERTIFICATE" } });
  fireEvent.click(credentialEditor.getByRole("button", { name: "保存牙医资质" }));
  expect(await screen.findByRole("row", { name: /林明远.*SYN-CERTIFICATE.*2028-12-31/ })).toBeTruthy();
});

test("the shared quarterly review keeps trial results across sample identities", async () => {
  open("operations/quarter","calculate");
  fireEvent.click(await screen.findByRole("button",{name:"2026 年第 4 季度"}));
  fireEvent.click(await screen.findByRole("button",{name:"运行试算"}));
  expect(await screen.findByRole("heading",{name:/第 1 版 · 待核对/})).toBeTruthy();
  fireEvent.click(screen.getByText("更多身份", {exact:true}));
  fireEvent.click(screen.getByRole("button", {name:"总部绩效复核",exact:true}));
  fireEvent.change(await screen.findByLabelText("查看版本"),{target:{value:"1"}});
  fireEvent.change(await screen.findByLabelText("复核理由"),{target:{value:"核过合成总账和分摊依据"}});
  fireEvent.click(screen.getByRole("button",{name:"提交复核"}));
  expect(await screen.findByText(/核过合成总账和分摊依据/)).toBeTruthy();
  fireEvent.click(screen.getByText("更多身份", {exact:true}));
  fireEvent.click(screen.getByRole("button", {name:"总部绩效确认",exact:true}));
  fireEvent.change(await screen.findByLabelText("查看版本"),{target:{value:"1"}});
  fireEvent.click(await screen.findByRole("button",{name:"确认第 1 版"}));
  expect(await screen.findByRole("heading",{name:/第 1 版 · 正式确认/})).toBeTruthy();
});

test("assistant uses operating report evidence in the shared workspace", async () => {
  open("operations/ai?date_from=2026-11-24&date_to=2026-11-26","scheduler");
  fireEvent.click(await screen.findByRole("button",{name:"对比两店实际就诊率"}));
  fireEvent.click(screen.getByRole("button",{name:"发送"}));
  const conversation = await screen.findByRole("log",{name:"经营对话"});
  expect(await within(conversation).findByText("对比两店实际就诊率",{exact:true})).toBeTruthy();
  const [current] = await within(conversation).findAllByRole("button",{name:"查看原报表"});
  fireEvent.click(current);
  expect(await screen.findByRole("heading",{name:"预约履约"})).toBeTruthy();
});
