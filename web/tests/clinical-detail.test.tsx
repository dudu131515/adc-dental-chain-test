import { useState } from "react";
import { ClinicalWorkspace } from "../src/features/clinical/ClinicalQueue";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { VisitDetail } from "../src/features/clinical/VisitDetail";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

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

test("an authorized historical visit returns to the records list with the same search", async () => {
  window.history.replaceState({}, "", "/clinical/records");
  vi.stubGlobal("fetch", async (path: string) => {
    const booking = {
      appointment_id: "15", appointment_no: "ADC-VISIT-MATCH", status: "COMPLETED", clinic: {clinic_id:"1", name:"合成店"},
      patient_display: {name:"合成归档患者"}, visit_id:"21", visit_status:"COMPLETED",
      start_at:"2030-10-17T10:00:00+08:00", ended_at:"2030-10-17T11:00:00+08:00",
    };
    const visit = {visit_id:"21", appointment_id:"15", appointment_no:booking.appointment_no, status:"COMPLETED", main_dentist_id:"9",
      patient_display:booking.patient_display, started_at:booking.start_at, ended_at:booking.ended_at,
      treatment_items:[], estimated_amount:"0.00", clinic_name:"合成店", dentist_name:"合成牙医"};
    return new Response(JSON.stringify({data:path.includes("/visits/21")?visit:{items:[booking]}}));
  });
  function Example() {
    const [path, open] = useState("/clinical/records");
    return <ClinicalWorkspace section="/clinical" clinicId="1" path={path} open={open}
      identity={{account_id:"9", employee_id:"9", category:"staff", capabilities:["DENTIST"], clinics:[{clinic_id:"1", name:"合成店"}]}} />;
  }
  render(<Example />);
  const search = await screen.findByRole("searchbox", {name:"姓名或预约号"});
  fireEvent.change(search, {target:{value:"ADC-VISIT-MATCH"}});
  fireEvent.click(await screen.findByRole("button", {name:"合成归档患者"}));
  await screen.findByRole("heading", {name:"合成归档患者"});
  fireEvent.click(screen.getByRole("button", {name:"返回诊疗记录"}));
  expect((screen.getByRole("searchbox", {name:"姓名或预约号"}) as HTMLInputElement).value).toBe("ADC-VISIT-MATCH");
  expect(await screen.findByRole("button",{name:"合成归档患者"})).toBeTruthy();
});

test("refreshing deposit status keeps the treatment operation available under its original key", async () => {
  const keys: string[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const reply = (data: unknown) => new Response(JSON.stringify({ data }));
    if (path.endsWith("/csrf")) return reply({ csrf_token: "synthetic" });
    if (path.endsWith("/clinical-context")) return reply(null);
    if (path.endsWith("/catalog/treatments")) return reply({items:[
      {treatment_type_id:"1", treatment_name:"合成检查", standard_unit:"次", active:true},
    ]});
    if (path.endsWith("/clinical/materials")) return reply({items:[]});
    if (path.endsWith("/treatment-items")) {
      keys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      if (keys.length === 1) throw Error("Synthetic response lost");
      return reply({item_id:"2"});
    }
    return reply({visit_id:"21", main_dentist_id:"9", appointment_id:"15", appointment_no:"ADC-21", status:"IN_PROGRESS",
      started_at:"2030-10-17T10:00:00+08:00", treatment_items:[], estimated_amount:"0.00", planned_treatment_type_id:"1",
      refund:{status:"PENDING", amount:"50.00", refund_id:"8"}});
  });
  render(<VisitDetail id="21" open={() => {}} />);
  const save = await screen.findByRole("button",{name:"保存实际项目"});
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await screen.findByRole("button",{name:"核对原办理结果"});
  fireEvent.click(screen.getByRole("button",{name:"核对预约金结果"}));
  await screen.findByRole("heading",{name:"记录实际治疗"});
  fireEvent.click(await screen.findByRole("button",{name:"核对原办理结果"}));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});
