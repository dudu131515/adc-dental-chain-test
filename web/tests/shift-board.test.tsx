import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { createSampleWorkspace } from "../demo/sampleWorkspace";
import { ShiftBoard } from "../src/features/schedule/ShiftBoard";
import { ApiTransport } from "../src/shared/ApiTransport";

afterEach(cleanup);

test("an empty cell opens a draft for that doctor and date", async () => {
  const request = vi.fn(async (path: string) => {
    if (path.startsWith("/schedule/dentists")) return {
      items: [{ dentist_id: "7", name: "合成牙医", qualifications: [] }],
    };
    if (path.startsWith("/clinics")) return { items: [{ clinic_id: "1", name: "合成甲店" }] };
    if (path.startsWith("/shift-demands")) return { items: [] };
    return { shifts: [], appointments: [], shortages: [], conflicts: [] };
  });

  render(<ApiTransport.Provider value={request as never}>
    <ShiftBoard clinicId="1" initialWeek="2030-10-14" identity={{
      account_id: "4", category: "staff", employee_id: "12", capabilities: ["HQ_SCHEDULER"],
      clinics: [{ clinic_id: "1", name: "合成甲店" }],
    }} />
  </ApiTransport.Provider>);

  fireEvent.click(await screen.findByRole("button", { name: "为合成牙医添加 2030-10-16 班次" }));
  expect((await screen.findByLabelText("牙医") as HTMLSelectElement).value).toBe("7");
  expect((screen.getByLabelText("开始") as HTMLInputElement).value).toBe("2030-10-16T09:00");
});

test("the shared demo saves multiple weekly drafts and submits the selected set", async () => {
  const workspace = createSampleWorkspace();
  render(<ApiTransport.Provider value={workspace.transport("scheduler")}>
    <ShiftBoard clinicId="central" initialWeek="2026-12-07" identity={workspace.identity("scheduler")} />
  </ApiTransport.Provider>);
  await screen.findByRole("rowheader", { name: "林明远" });
  fireEvent.click(screen.getByRole("button", { name: "批量拟排" }));
  const form = screen.getByRole("form", { name: "批量拟排" });
  fireEvent.click(within(form).getByRole("checkbox", { name: "林明远" }));
  fireEvent.click(within(form).getByRole("checkbox", { name: "12-07" }));
  fireEvent.click(within(form).getByRole("checkbox", { name: "12-08" }));
  fireEvent.click(within(form).getByRole("button", { name: "保存批量草案" }));
  await screen.findByText("已保存草案 2 个班次。");

  await screen.findAllByRole("button", { name: /09:00.*中心口腔门诊.*草案/ });
  fireEvent.click(screen.getByRole("button", { name: "批量提交" }));
  fireEvent.click(screen.getByRole("button", { name: "选择全部可办理班次" }));
  fireEvent.click(screen.getByRole("button", { name: "提交所选草案" }));
  await screen.findByText("已提交确认 2 个班次。");
  expect(await screen.findAllByRole("button", { name: /09:00.*中心口腔门诊.*待牙医确认/ })).toHaveLength(2);
});
