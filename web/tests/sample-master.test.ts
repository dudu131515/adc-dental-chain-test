import { expect, test } from "vitest";
import { createSampleWorkspace } from "../demo/sampleWorkspace";

test("master data edits are shared with scheduler, clinical materials and staff access", async () => {
  const workspace = createSampleWorkspace();
  const admin = workspace.transport("admin");
  const scheduler = workspace.transport("scheduler");
  const dentist = workspace.transport("dentist");
  const front = workspace.transport("front");
  await expect(front("/admin/chairs")).rejects.toMatchObject({status:403});
  const branch = await admin<{clinic_id:string}>("/admin/clinics",{method:"POST",body:{
    clinic_no:"SYN-WEST",name:"合成西门诊",address:"合成地址",phone:null,email:null,status:"ACTIVE",
  }});
  expect(await scheduler<{items:{clinic_id:string;name:string}[]}>("/clinics")).toMatchObject({
    items:expect.arrayContaining([expect.objectContaining({clinic_id:branch.clinic_id,name:"合成西门诊"})]),
  });
  const chair = await admin<{chair_id:string}>("/admin/chairs",{method:"POST",body:{
    clinic_id:branch.clinic_id,chair_no:"SYN-C1",chair_kind:"GENERAL",status:"AVAILABLE",
  }});
  const board = "/schedule/board?view=day&date_from=2026-11-25&date_to=2026-11-25&clinic_id="+branch.clinic_id;
  expect(await scheduler(board)).toMatchObject({unavailable:[]});
  await admin("/admin/chairs/"+chair.chair_id,{method:"PATCH",body:{
    clinic_id:branch.clinic_id,chair_no:"SYN-C1",chair_kind:"GENERAL",status:"INACTIVE",
  }});
  expect(await scheduler(board)).toMatchObject({unavailable:[{start_at:"2026-11-25T00:00:00+08:00"}]});
  await admin("/admin/chairs/"+chair.chair_id,{method:"PATCH",body:{
    clinic_id:branch.clinic_id,chair_no:"SYN-C1",chair_kind:"GENERAL",status:"AVAILABLE",
  }});
  const employee = await admin<{employee_id:string}>("/admin/access/employees",{method:"POST",body:{
    employee_no:"SYN-NEW",full_name:"合成新牙医",job_code:"DENTIST",home_clinic_id:branch.clinic_id,
  }});
  await admin("/admin/access/employees/"+employee.employee_id+"/grants",{method:"POST",body:{
    clinic_id:branch.clinic_id,role_code:"DENTIST",expected_granted:false,granted:true,reason:"合成任职授权",
  }});
  const qualification = await admin<{qualification_id:string}>("/admin/qualifications",{method:"POST",body:{
    qualification_code:"SYN-ENDO",qualification_name:"合成专科",
  }});
  await admin("/admin/dentist-qualifications",{method:"POST",body:{
    employee_id:employee.employee_id,qualification_id:qualification.qualification_id,
    certificate_no:"SYN-001",valid_from:"2025-01-01",valid_until:"2028-12-31",
  }});
  expect(await scheduler("/schedule/dentists?clinic_id="+branch.clinic_id)).toMatchObject({
    items:[{dentist_id:employee.employee_id,name:"合成新牙医",qualifications:[{name:"合成专科"}]}],
  });
  const material = await admin<{material_id:string}>("/admin/materials",{method:"POST",body:{
    material_code:"SYN-GLOVE",material_name:"合成检查耗材",standard_unit:"套",status:"ACTIVE",
  }});
  await admin("/admin/materials/"+material.material_id+"/costs",{method:"POST",body:{
    unit_cost:"18.30",effective_from:"2026-11-25",effective_to:null,
  }});
  expect(await dentist("/clinical/materials")).toMatchObject({
    items:expect.arrayContaining([expect.objectContaining({material_id:material.material_id,material_name:"合成检查耗材"})]),
  });
});
