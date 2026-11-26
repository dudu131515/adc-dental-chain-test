import { expect, it } from "vitest";
import { createSampleClinical, type SampleClinicalActor } from "../demo/sampleClinical";
import type { Appointment as Fixture } from "../demo/fixtures";
import { createSampleWorkspace } from "../demo/sampleWorkspace";
import type { Visit } from "../src/features/clinical/clinicalTypes";
import type { Appointment, Chair } from "../src/features/schedule/appointmentTypes";

it("moves a checked-in appointment through treatment and releases its chair for settlement", () => {
  const row: Fixture = {id:"ADC-DEMO-1",date:"2026-11-25",clinic:"central",time:"10:00",
    patient:"演示患者",patientId:"1",service:"口腔检查",doctor:"演示牙医",status:"booked"};
  const appointment = (entry: Fixture, actor?: SampleClinicalActor) => ({
    appointment_id:entry.id, appointment_no:entry.id, claim_id:"200", status:entry.status, is_attended:false,
    clinic:{clinic_id:"central",name:"中心门诊",address:""}, dentist:{dentist_id:"1",name:entry.doctor},
    treatment:{treatment_type_id:"1",name:entry.service},
    deposit:!actor || actor.allowed(["FRONT_DESK"]) ? {deposit_id:"300",amount:"50.00",status:"PAID"} : undefined,
    start_at:"2026-11-25T10:00:00+08:00", end_at:"2026-11-25T10:30:00+08:00", allowed_actions:[],
  });
  let next = 1000;
  const clinical = createSampleClinical({appointments:[row], appointment, id:()=>String(++next), clockDate:row.date,
    chairs:[{chair_id:"1",clinic_id:"central",chair_no:"A-01",chair_kind:"GENERAL",status:"ACTIVE",unavailability:[]}],
    treatments:[{treatment_type_id:"1",treatment_name:"口腔检查",standard_unit:"次",current_unit_price:"80.00"},
      {treatment_type_id:"2",treatment_name:"洁牙护理",standard_unit:"次",current_unit_price:"180.00"}],
  });
  const staff = (role: string, employee: string): SampleClinicalActor => ({
    allowed:roles=>roles.includes(role), authorize:roles=>{if(!roles.includes(role)) throw new Error("角色无权操作");},
    dentist:()=>employee,
  });
  const front = staff("FRONT_DESK", "4"), dentist = staff("DENTIST", "1");
  const run = (actor: SampleClinicalActor, path: string, body?: Record<string, unknown>) =>
    clinical.dispatch(path, new URLSearchParams(), body ? "POST" : "GET", body ?? {}, actor);
  const base = "/appointments/" + row.id;
  expect(() => run(front,base+"/check-in",{expected_claim_id:"199",identity_confirmed:true})).toThrow("预约安排已变化");
  run(front,base+"/check-in",{expected_claim_id:"200",identity_confirmed:true});
  expect(run(front,base+"/chair-options")).toMatchObject({items:[{chair_id:"1"}]});
  const review = {expected_claim_id:"200",expected_version:"0",status:"KNOWN",allergies:[{allergen:"乳胶"}]};
  run(dentist,base+"/allergy-reviews",review);
  expect(() => run(dentist,base+"/allergy-reviews",review)).toThrow("患者过敏记录已更新");
  expect(run(dentist,base+"/clinical-context")).toMatchObject({allergies:[{allergen:"乳胶"}],
    allergy_review:{status:"KNOWN",history:[{changes:{added:1,updated:0,removed:0}}]}});
  expect(() => run(dentist,base+"/start-visit",{expected_claim_id:"200"})).toThrow("当前牙椅不可用");
  run(front,base+"/assign-chair",{expected_claim_id:"200",chair_id:"1"});
  const visit = run(dentist,base+"/start-visit",{expected_claim_id:"200"}) as {visit_id:string};
  const visitPath = "/visits/" + visit.visit_id;
  expect(run(front,visitPath)).toMatchObject({status:"IN_PROGRESS",can_issue_invoice:false});
  expect(run(front,visitPath)).not.toHaveProperty("main_dentist_id");
  const savedTreatment = {treatment_type_id:"1",units:"1.500",materials:[
    {material_id:"1",quantity:"2",cost_evidence_ref:"ADC-DEMO-COST-001"},
  ]};
  expect(() => run(dentist,visitPath+"/treatment-items",{...savedTreatment,treatment_type_id:"2"})).toThrow("患者同意");
  expect(() => run(dentist,visitPath+"/treatment-items",{...savedTreatment,materials:[
    ...savedTreatment.materials,{material_id:"2",quantity:"1",cost_evidence_ref:"ADC-DEMO-COST-001"},
  ]})).toThrow("耗材与成本凭据");
  expect(clinical.visit(visit.visit_id)).toMatchObject({treatment_items:[],materials:[]});
  run(dentist,visitPath+"/treatment-items",savedTreatment);
  run(dentist,visitPath+"/finish",{clinical_notes:"演示诊疗记录"});
  expect(row.status).toBe("done");
  expect(clinical.chairForAppointment(row.id)).toBeNull();
  expect(clinical.visitForAppointment(row.id)).toMatchObject({visit_id:visit.visit_id,status:"COMPLETED",
    estimated_amount:"120.00",clinical_notes:"演示诊疗记录",refund:{amount:"50.00",status:"SUCCEEDED"},
    materials:[{name:"一次性口腔检查包",quantity:"2.000",unit_cost:"8.00"}],
    allergy_reviews:[{status:"KNOWN"}]});
  expect(run(front,visitPath)).toMatchObject({can_issue_invoice:true});
  row.invoice = "950";
  expect(run(dentist,visitPath)).toMatchObject({invoice_id:"950"});
});

it("hands a terminated visit from the dentist to the front desk for zero-balance settlement", async () => {
  const workspace = createSampleWorkspace();
  const front = workspace.transport("front");
  const dentist = workspace.transport("dentist");
  const appointmentPath = "/appointments/ADC-DEMO-010";
  const appointment = await front<Appointment>(appointmentPath);
  const {items: [chair]} = await front<{items: Chair[]}>(appointmentPath + "/chair-options");
  await front(appointmentPath + "/assign-chair", {method:"POST",body:{expected_claim_id:appointment.claim_id,chair_id:chair.chair_id}});
  const start = await dentist<Visit>(appointmentPath + "/start-visit", {method:"POST",body:{expected_claim_id:appointment.claim_id}});
  expect(start).toMatchObject({status:"IN_PROGRESS",refund:{status:"SUCCEEDED",amount:"50.00"}});
  const visitPath = "/visits/" + start.visit_id;
  await dentist(visitPath + "/terminate", {method:"POST",body:{reason:"患者改期治疗"}});
  const queue = await front("/billing/queue?clinic_id=central&status=WAITING_INVOICE", {queueSearch:"ADC-DEMO-010"});
  expect(queue).toMatchObject({items:[{visit_id:start.visit_id,status:"TERMINATED",billing_state:"WAITING_INVOICE"}]});
  expect(await front(visitPath + "/invoice", {method:"POST",body:{}})).toMatchObject({
    visit_id:start.visit_id,original_total:"0.00",status:"SETTLED",deposit_refund:{status:"SUCCEEDED",amount:"50.00"},
  });
  expect(await front(appointmentPath)).toMatchObject({status:"COMPLETED",chair:null});
});
