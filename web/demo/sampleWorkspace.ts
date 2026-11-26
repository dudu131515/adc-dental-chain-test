import { jobLabels, roleNames, type JobCode, type StaffIdentity } from "../src/shared/navigation";
import { addDays, localDate as shanghaiDate, localTime } from "../src/features/schedule/types";
import type { Candidate } from "../src/features/schedule/appointmentTypes";
import type { Dentist, Shift } from "../src/features/schedule/types";
import type { Demand } from "../src/features/schedule/ShiftDemandForm";
import type { Company, Version } from "../src/features/operations/VersionComparison";
import type { Period } from "../src/features/operations/ExpensesPage";
import { ApiError } from "../src/shared/api";
import { appointments, catalog, chairs, clinics, dailyFacts, days, invoices, staffShifts, type Appointment } from "./fixtures";
import { createSampleMasterData, type SampleBranch, type SampleEmployee, type SampleQualification, type SampleResource } from "./sampleMasterData";
import { appointmentEnd, appointmentStart, appointmentStates, coordinatorRoles, createSampleAppointments, type SampleActor } from "./sampleAppointments";
import { createSampleAssistant } from "./sampleAssistant";
import { createSampleBilling } from "./sampleBilling";
import { createSampleClinical } from "./sampleClinical";
import { runSampleShiftBatch, sampleShiftInsights } from "./sampleShiftBatch";
import type { BoardShift } from "../src/features/schedule/shiftBoardTypes";

export const sampleDate = days[0];
export const sampleTime = sampleDate + "T15:30:00+08:00";

export const sampleRoles = {
  visitor: {label:"参观总览", employee:"0", roles:[]},
  scheduler: {label:"总部管理人员", employee:"6", roles:["HQ_SCHEDULER","HQ_CATALOG","HQ_OPERATIONS_QUERY",
    "HQ_PERFORMANCE_CALCULATE","HQ_PERFORMANCE_REVIEW","HQ_PERFORMANCE_CONFIRM"]},
  dentist: {label:"牙医", employee:"1", roles:[]},
  dentist2: {label:"牙医 · 周宁", employee:"2", roles:[]},
  dentist3: {label:"牙医 · 何可", employee:"3", roles:[]},
  dentist4: {label:"牙医 · 顾然", employee:"13", roles:[]},
  manager: {label:"诊所主管", employee:"5", roles:[]},
  front: {label:"前台", employee:"4", roles:[]},
  reports: {label:"总部经营查询", employee:"8", roles:["HQ_OPERATIONS_QUERY"]},
  calculate: {label:"总部绩效核算", employee:"9", roles:["HQ_PERFORMANCE_CALCULATE"]},
  review: {label:"总部绩效复核", employee:"10", roles:["HQ_PERFORMANCE_REVIEW"]},
  confirm: {label:"总部绩效确认", employee:"11", roles:["HQ_PERFORMANCE_CONFIRM"]},
  catalog: {label:"总部项目管理", employee:"7", roles:["HQ_CATALOG"]},
  admin: {label:"系统管理员", employee:"12", roles:["HQ_ACCESS_ADMIN"]},
} as const;
export type SampleRole = keyof typeof sampleRoles;
const originalBranches: SampleBranch[] = Object.entries(clinics).map(([clinic_id,name], index) => ({
  clinic_id, name, clinic_no:index ? "ADC-B02" : "ADC-A01", status:"ACTIVE",
  address:index ? "示例大道 56 号" : "示例路 18 号", phone:null, email:null,
}));
const editable = ["FRONT_DESK","DENTIST","CLINIC_MANAGER","HQ_SCHEDULER","HQ_CATALOG","HQ_OPERATIONS_QUERY"];
const grants = (role_code:string, ...ids:string[]) => ids.map(clinic_id=>({role_code,clinic_id}));
const originalEmployees: [string,string,JobCode,string|null,ReturnType<typeof grants>][] = [
  ["1","林明远","DENTIST","central",grants("DENTIST","central","river")],
  ["2","周宁","DENTIST","central",grants("DENTIST","central")],
  ["3","何可","DENTIST","river",grants("DENTIST","river")],
  ["4","陈晓前","FRONT_DESK","central",grants("FRONT_DESK","central")],
  ["5","苏文","CLINIC_MANAGER","central",grants("CLINIC_MANAGER","central")],
  ["6","彭航","HEADQUARTERS",null,[]],["7","邵敏","HEADQUARTERS",null,[]],
  ["8","江静","HEADQUARTERS",null,[]],["9","程瑜","HEADQUARTERS",null,[]],
  ["10","柳嘉","HEADQUARTERS",null,[]],["11","李岚","HEADQUARTERS",null,[]],
  ["12","陈虹","HEADQUARTERS",null,[]],
  ["13","顾然","DENTIST","river",grants("DENTIST","river")],
  ["14","潘云","FRONT_DESK","river",grants("FRONT_DESK","river")],
  ["15","胡怡","CLINIC_MANAGER","river",grants("CLINIC_MANAGER","river")],
  ["16","纪诚","HEADQUARTERS",null,[]],
];
const globalStaffRoles = new Map<string, readonly string[]>(
  Object.values(sampleRoles).map(({employee,roles}) => [employee,roles]),
);
const originalQualifications: SampleQualification[] = [
  {qualification_id:"1",qualification_code:"ADC-Q01",qualification_name:"口腔执业医师"},
  {qualification_id:"2",qualification_code:"ADC-Q02",qualification_name:"牙体牙髓治疗"},
  {qualification_id:"3",qualification_code:"ADC-Q03",qualification_name:"儿童口腔诊疗"},
];
const priceSamples = [...catalog,
  {code:"ENDO",name:"根管治疗",price:690,duration:60,date:"2026-08-01"},
  {code:"PED",name:"儿童窝沟封闭",price:220,duration:40,date:"2026-10-01"},
  {code:"XRY",name:"口腔影像检查",price:120,duration:20,date:"2026-07-01"},
  {code:"PERIO",name:"牙周基础治疗",price:520,duration:60,date:"2026-09-01"},
];
type Price={price_id:string;unit_price:string;effective_from:string;effective_to:string|null};
type Audit={audit_id:string;action:string;occurred_at:string;actor_account_id:string;before:Record<string,unknown>;after:Record<string,unknown>};
type Body = Record<string,unknown>;
const shanghaiTime = (value: Date) => localTime(value.toISOString());
const dateOf = (value:string) => value.slice(0,10);
const at = (date:string,time:string) => date+"T"+time+":00+08:00";
const finite = (value:unknown) => Number.isFinite(Number(value));
function problem(status:number, message:string):never {
  throw new ApiError(status,{code:status===403?"PERMISSION_DENIED":status===409?"CONFLICT":status===404?"NOT_FOUND":"VALIDATION_ERROR",message});
}
function ensureDates(start:string,end:string) {
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start)>=Date.parse(end)) {
    problem(400,"请填写有效的开始和结束时间。");
  }
}
const overlap = (a:string,b:string,c:string,d:string) => Date.parse(a)<Date.parse(d) && Date.parse(c)<Date.parse(b);

function company(revenue:number,material:number,operating:number):Company {
  const net=revenue-material-operating;
  return {revenue:revenue.toFixed(2),material_cost:material.toFixed(2),operating_cost:operating.toFixed(2),
    net_profit:net.toFixed(2),incentive_fund:(Math.max(0,net)*0.10).toFixed(2)};
}
function version(period_id:string, revision_no:number, status:string, revenue:number, operating:number, original?:Company):Version {
  const current=company(revenue,9500,operating);
  return {period_id,revision_no,status,company:current,original_company:original,
    ...(original ? {company_delta:Object.fromEntries(Object.keys(current).map(key=>[key,
      (Number(current[key as keyof Company])-Number(original[key as keyof Company])).toFixed(2)])) as Company} : {}),
    unallocated_amount:"0.00",
    ...(status==="CONFIRMED"?{confirmed_at:at("2026-10-16","11:20"),confirmed_by:"样例总部确认"}:{}),
    dentists: [{clinic_id:"central",dentist_id:"1",basis_minutes:"9600",revenue:(revenue*.6).toFixed(2),material_cost:"5700.00",
      operating_cost:(operating*.6).toFixed(2),net_profit:((revenue-9500-operating)*.6).toFixed(2)},
      {clinic_id:"river",dentist_id:"3",basis_minutes:"6400",revenue:(revenue*.4).toFixed(2),material_cost:"3800.00",
      operating_cost:(operating*.4).toFixed(2),net_profit:((revenue-9500-operating)*.4).toFixed(2)}],
    expenses:["租赁","设备维护","诊室消毒","行政支持"].map((category,index)=>({expense_id:String(index+1),
      clinic_id:index%2?"river":"central",scope:"SHARED",category,amount:(operating/4).toFixed(2),unallocated_amount:"0.00",
      evidence_ref:"ADC-EXP-Q"+period_id+"-"+(index+1),allocations:[{dentist_id:index%2?"3":"1",amount:(operating/4).toFixed(2),basis_minutes:index%2?"6400":"9600"}]})),
    visits:[1,2,3,4,5,6].map(id=>({visit_id:"V-"+(100+id),clinic_id:id%2?"central":"river",
      dentist_id:id%2?"1":"3",ended_at:at("2026-09-"+(10+id),"10:50"),accrued:(320+id*75).toFixed(2),invoice_id:"INV-"+(250+id),
      work_sessions:[{work_id:"W-"+id,dentist_id:id%2?"1":"3",minutes:String(30+id*5)}],
      materials:[{usage_id:"M-"+id,material_id:"M12",quantity:"2",unit_cost:"22.00"}]})),
  };
}

export function createSampleWorkspace() {
  const previewAppointments = appointments.map(row => ({...row}));
  const bills = structuredClone(invoices);
  const deposits: {appointment_id:string; deposit_id:string; claim_id:string; amount:string; paid_at:string; clinic_id:string}[] = [];
  const assistants = new Map<SampleRole, ReturnType<typeof createSampleAssistant>>();
  const replay = new Map<SampleRole, Map<string,{signature:string;result:unknown}>>();
  const specialRequirements = new Map<string,string>();
  type Hold = Candidate & {patient_id:string;claim_id:string;status:string;server_time:string;expires_at:string; specialRequirement?:string;
    payment:{deposit_id:string;amount:string;status:string}; appointment_id?:string;appointment_no?:string};
  const holds = new Map<string,Hold>();
  const holdActions = new Map<string,Hold>();
  const branches = originalBranches.map(row=>({...row}));
  const qualifications = originalQualifications.map(row=>({...row}));
  const employees: SampleEmployee[] = originalEmployees.map(([employee_id,full_name,job_code,home_clinic_id,roles])=>({
    employee_id,full_name,job_code,home_clinic_id,employee_no:"ADC-E"+employee_id.padStart(3,"0"),
    employee_status:employee_id==="16"?"ON_LEAVE":"ACTIVE",account_status:employee_id==="16"?"INACTIVE":"ACTIVE",
    can_manage_grants:employee_id!=="12",can_manage_account:["1","2","3","4","5","13","14","15","16"].includes(employee_id),
    grants:[...roles],
  }));
  const audits=new Map<string,Audit[]>();
  const originalDentists=employees.filter(e=>e.grants.some(g=>g.role_code==="DENTIST"));
  const credentials=originalDentists.flatMap((employee,index)=>qualifications.slice(0,index===3?1:2).map(q=>({
    credential_id:employee.employee_id+"-"+q.qualification_id,employee_id:employee.employee_id,qualification_id:q.qualification_id,
    certificate_no:"ADC-CERT-"+employee.employee_id+q.qualification_id,valid_from:"2025-01-01",valid_until:"2028-12-31",
  })));
  const status:Record<string,string>={"已发布":"PUBLISHED","待回应":"PENDING"};
  const shifts:BoardShift[]=staffShifts.map((row,index)=>({shift_id:String(index+1),clinic_id:row.clinic,
    dentist_id:originalDentists.find(p=>p.full_name===row.doctor)!.employee_id,
    start_at:at(row.date,row.time.split("–")[0]),end_at:at(row.date,row.time.split("–")[1]),status:status[row.status]}));
  for (const [index,day] of ["23","24","27","29"].entries()) {
    for (const [offset,doctor] of originalDentists.entries()) {
      const clinic=doctor.grants[0].clinic_id;
      shifts.push({shift_id:"8"+index+offset,clinic_id:clinic,dentist_id:doctor.employee_id,
        start_at:at("2026-11-"+day,"08:30"),end_at:at("2026-11-"+day,"12:00"),
        status:index===3&&offset===0?"DRAFT":"PUBLISHED"});
    }
  }
  const previousWeek = shifts.filter(row => row.status==="PUBLISHED" && dateOf(row.start_at)==="2026-11-23");
  shifts.push(...previousWeek.map(row => ({
    ...row, shift_id:"7"+row.shift_id,
    start_at:at(addDays(dateOf(row.start_at),-7),shanghaiTime(new Date(row.start_at))),
    end_at:at(addDays(dateOf(row.end_at),-7),shanghaiTime(new Date(row.end_at))),
  })));
  shifts.push({shift_id:"799",clinic_id:"central",dentist_id:"2",status:"PUBLISHED",
    start_at:at("2026-11-17","14:00"),end_at:at("2026-11-17","17:00")});
  const demands:Demand[]=[1,2,3,4,5,6].map(i=>({demand_id:String(i),clinic_id:i%2?"central":"river",
    start_at:at("2026-11-"+(23+i),"08:00"),end_at:at("2026-11-"+(23+i),"18:00"),
    required_qualification_id:i%3===0?"2":null,required_count:i%2?2:1}));
  type ReportItem = {appointment_no:string; clinic_id:string; dentist_id?:string; service_date:string;
    status:string; invoice_no?:string; visit_id?:string; accrued?:number; received?:number; refunded?:number; outstanding?:number;
    minutes?:number};
  const reports=new Map<string,{items:ReportItem[];asOf:string;details?:Record<string,Record<string,unknown>[]>}>();
  let next=1000;
  const id=()=>String(++next);
  const periods:Period[]=[{period_id:"4",year:2026,quarter:4},{period_id:"3",year:2026,quarter:3},
    {period_id:"2",year:2026,quarter:2},{period_id:"1",year:2026,quarter:1},{period_id:"0",year:2025,quarter:4}];
  const revisions=new Map<string,Version[]>(periods.map(item=>[item.period_id, item.period_id==="4"?[]:[
    version(item.period_id,1,"CONFIRMED",74000+Number(item.period_id)*6000,23000),
  ]]));
  const v3base=revisions.get("3")![0];
  revisions.get("3")!.push({...version("3",2,"CONFIRMED",91680,23000,v3base.company),
    source:{adjustment_id:"ADC-ADJ-347",invoice_id:"INV-258",visit_id:"V-108",approver_id:"5",
      signed_amount:"-320.00",approved_at:at("2026-10-13","10:30")}});
  const expenses = periods.flatMap(p=>["租赁","设备维护","诊室消毒","水电","行政支持","员工培训"].map((expense_category,i)=>({
    expense_id:p.period_id+"0"+i,period_id:p.period_id,clinic_id:i%2?"river":"central",expense_category,
    scope:"SHARED",amount:(320+i*230).toFixed(2),evidence_ref:"ADC-EXP-"+p.period_id+"-"+i,
  })));
  const resources: SampleResource[]=chairs.map((row,index)=>({chair_id:String(index+1),clinic_id:row.clinic,chair_no:row.code,
    chair_kind:"GENERAL",status:"AVAILABLE",unavailability:[]}));
  const standards=priceSamples.map((row,index)=>({treatment_type_id:String(index+1),treatment_code:row.code,treatment_name:row.name,
    standard_unit:"次",required_qualification_id:index===3?"2":null,default_slot_minutes:row.duration as number|null,
    required_chair_kind:"GENERAL",active:true,current_unit_price:row.price.toFixed(2) as string|null}));
  const prices=new Map<string,Price[]>(priceSamples.map((row,index)=>[String(index+1),[
    {price_id:"current"+index,unit_price:row.price.toFixed(2),effective_from:row.date,effective_to:null},
    {price_id:"prior"+index,unit_price:(row.price-5).toFixed(2),effective_from:"2026-01-01",effective_to:row.date},
  ]]));
  const clinicName = (clinicId:string) => branches.find(row=>row.clinic_id===clinicId)?.name ?? clinicId;
  const operating = (clinicId:string) => branches.some(row=>row.clinic_id===clinicId && row.status==="ACTIVE");
  const doctorId = (row: Appointment) => row.dentistId ?? employees.find(p=>p.full_name===row.doctor)?.employee_id ?? "";
  const treatment = (row: Appointment) => standards.find(p=>row.treatmentId
    ? p.treatment_type_id===row.treatmentId : p.treatment_name===row.service);
  for (const row of previewAppointments) row.treatmentId=treatment(row)?.treatment_type_id;
  const master = createSampleMasterData({branches,employees,resources,qualifications,credentials,id,day:sampleDate,verifyChairChange});
  function people(): (Dentist & {clinic_ids:string[]})[] {
    return employees.filter(employee=>employee.employee_status==="ACTIVE").flatMap(employee=>{
      const clinic_ids=employee.grants.filter(grant=>grant.role_code==="DENTIST" && operating(grant.clinic_id)).map(grant=>grant.clinic_id);
      return clinic_ids.length ? [{dentist_id:employee.employee_id,name:employee.full_name,clinic_ids,
        qualifications:master.qualificationsFor(employee.employee_id)}] : [];
    });
  }
  function claims(clinicId:string,kind:string,omit?:string) {
    const scheduled=previewAppointments.filter(row=>row.id!==omit && row.clinic===clinicId
      && ["booked","arrived","treating"].includes(row.status) && (treatment(row)?.required_chair_kind ?? "GENERAL")===kind)
      .map(row=>({start_at:appointmentStart(row),end_at:appointmentEnd(row)}));
    const occupied=[...holds.values()].filter(row=>row.status==="HOLD" && row.clinic_id===clinicId
      && Date.parse(row.expires_at)>Date.now() && standards.find(item=>item.treatment_type_id===row.treatment_type_id)?.required_chair_kind===kind);
    return [...scheduled,...occupied];
  }
  function chairFree(row: SampleResource, start: string, end: string) {
    return row.status==="AVAILABLE" && !row.unavailability.some(block=>overlap(start,end,block.start_at,block.end_at));
  }
  function verifyChairChange(previous:SampleResource,next:SampleResource) {
    if (previous.clinic_id!==next.clinic_id && (clinical.hasChairHistory(previous.chair_id) || previous.unavailability.length))
      problem(409,"已有牙椅记录的资源不能跨门店移动。");
    const removed=next.status!=="AVAILABLE" || previous.clinic_id!==next.clinic_id || previous.chair_kind!==next.chair_kind;
    if (!removed || previous.status!=="AVAILABLE") return;
    if (clinical.chairInUse(previous.chair_id)) problem(409,"牙椅正在用于接诊，请先处理占用。");
    const others=resources.filter(row=>row!==previous && row.clinic_id===previous.clinic_id && row.chair_kind===previous.chair_kind);
    const upcoming=claims(previous.clinic_id,previous.chair_kind).filter(row=>Date.parse(row.end_at)>Date.parse(sampleTime));
    if(upcoming.some(item=>upcoming.filter(row=>overlap(item.start_at,item.end_at,row.start_at,row.end_at)).length
      > others.filter(row=>chairFree(row,item.start_at,item.end_at)).length))
      problem(409,"该变更影响已有占位或预约，请先核对排程。");
  }
  function dayOutages(clinicId:string,start:string,end:string) {
    const available=resources.filter(row=>row.clinic_id===clinicId && row.status==="AVAILABLE");
    if (!operating(clinicId) || !available.length) return [{start_at:start,end_at:end}];
    const first=Date.parse(start),last=Date.parse(end);
    const boundaries=[first,last,...available.flatMap(row=>row.unavailability.flatMap(span=>
      [Date.parse(span.start_at),Date.parse(span.end_at)].filter(value=>value>first && value<last)))];
    const times=[...new Set(boundaries)].sort((a,b)=>a-b);
    const unavailable:{start_at:string;end_at:string}[]=[];
    for(let i=0;i<times.length-1;i++){
      const start_at=new Date(times[i]).toISOString(),end_at=new Date(times[i+1]).toISOString();
      if(available.some(row=>chairFree(row,start_at,end_at))) continue;
      const previous=unavailable.at(-1);
      if(previous?.end_at===start_at) previous.end_at=end_at;
      else unavailable.push({start_at,end_at});
    }
    return unavailable;
  }
  const clinical = createSampleClinical({appointments:previewAppointments, chairs:resources,
    appointment:(row,actor) => registry.projection(row,actor), id, clockDate:sampleDate, treatments:standards,
    materialsFor:master.materialsFor, specialRequirement:appointmentId => specialRequirements.get(appointmentId)});
  const registry: ReturnType<typeof createSampleAppointments> = createSampleAppointments({
    appointments:previewAppointments,branches,doctorId,
    treatment,
    visit:clinical.visit,visitId:clinical.visitIdForAppointment,chair:clinical.chairForAppointment,
    treatmentRefund:clinical.refundForAppointment,
    billStatus:bill => bills[bill]?.outstanding === 0 ? "SETTLED" : bills[bill]?.received ? "PART_PAID" : "ISSUED",
    invoiceSummary:bill => {
      const row=bills[bill];
      const accrued=row?.due ?? 0,net=(row?.received ?? 0)-(row?.refunded ?? 0);
      return {accrued:accrued.toFixed(2),net_received:net.toFixed(2),outstanding:(row?.outstanding ?? 0).toFixed(2),
        refund_due:Math.max(0,net-accrued).toFixed(2)};
    },
    id,clock:sampleTime,
  });
  const billing = createSampleBilling({bills,appointments:previewAppointments,id,clockDate:sampleDate,visit:clinical.visit,
    doctorId,bookingDeposits:() => deposits,clinicName});

  function homeClinic(clinicId: string | null) {
    const branch = branches.find(c => c.clinic_id === clinicId);
    return branch ? {clinic_id:branch.clinic_id,name:branch.name} : null;
  }

  function identity(role:SampleRole):StaffIdentity {
    const actor = sampleRoles[role];
    const owner = employees.find(e => e.employee_id === actor.employee);
    const active = owner?.account_status === "ACTIVE" && owner.employee_status !== "INACTIVE";
    const global = active ? globalStaffRoles.get(actor.employee) ?? [] : [];
    const scoped = active ? owner.grants : [];
    const capabilities = [...new Set([...global, ...scoped.map(grant => grant.role_code)])];
    const clinics = global.some(code => code !== "HQ_ACCESS_ADMIN") ? branches
      : branches.filter(clinic => scoped.some(grant => grant.clinic_id === clinic.clinic_id));
    return {account_id:actor.employee,employee_id:actor.employee,category:"staff",capabilities,clinics,
      full_name:owner?.full_name,employee_no:owner?.employee_no,job_code:owner?.job_code,
      home_clinic:homeClinic(owner?.home_clinic_id ?? null),employee_status:owner?.employee_status,
      account_status:owner?.account_status ?? null,
      role_clinic_ids:Object.fromEntries(capabilities.map(code =>
        [code,global.includes(code) ? null : scoped.filter(grant => grant.role_code === code).map(grant => grant.clinic_id)]))};
  }

  function transport(role:SampleRole) {
    const processed = replay.get(role) ?? new Map<string,{signature:string;result:unknown}>();
    replay.set(role, processed);
    const assistant = assistants.get(role) ?? createSampleAssistant();
    assistants.set(role,assistant);
    const capability=(code:string,clinic?:string)=>{
      const staff=identity(role);
      return staff.capabilities.includes(code)&&(!clinic||staff.role_clinic_ids?.[code]==null
        ||staff.role_clinic_ids[code]!.includes(clinic));
    };
    const need=(code:string,clinic?:string)=>{if (!capability(code,clinic)) problem(403,"当前样例身份无权办理此项操作。");};
    const scheduleVisible = (row:Shift, dayView:boolean) => capability("HQ_SCHEDULER",row.clinic_id)
      || capability("CLINIC_MANAGER",row.clinic_id)
      || (dayView && capability("FRONT_DESK",row.clinic_id) && row.status === "PUBLISHED")
      || (row.dentist_id === sampleRoles[role].employee && capability("DENTIST",row.clinic_id) && row.status !== "DRAFT");
    const wanted=(filter:string|null,value:string)=>!filter||filter===value;

    const actor: SampleActor = {
      allowed:(roles,clinic) => roles.some(code => capability(code,clinic)),
      authorize:(roles,clinic) => {
        if (!roles.some(code => capability(code,clinic))) problem(403,"当前样例身份无权办理此项操作。");
      },
      dentist:() => sampleRoles[role].employee,
    };
    const appointmentRows=(clinic:string,start:string,end:string,doctor?:string)=>previewAppointments.filter(row=>
      row.clinic===clinic&&(!doctor||doctorId(row)===doctor)
      && ["booked","arrived","treating"].includes(row.status)&&overlap(start,end,appointmentStart(row),appointmentEnd(row)))
      .map(row=>({appointment_id:row.id,appointment_no:row.id,clinic_id:row.clinic,dentist_id:doctorId(row),
        start_at:appointmentStart(row),end_at:appointmentEnd(row),status:appointmentStates[row.status],patient_display:row.patient}));

    function validateDraft(shift:Shift) {
      if(!operating(shift.clinic_id)) problem(409,"请选择启用的门店。");
      const assigned=people().find(person=>person.dentist_id===shift.dentist_id)?.clinic_ids.includes(shift.clinic_id);
      if(!assigned) problem(409,"牙医未获该门店任职授权。");
      const demand=demands.find(x=>x.demand_id===shift.demand_id);
      if (shift.demand_id && (!demand || demand.clinic_id!==shift.clinic_id ||
          Date.parse(shift.start_at)<Date.parse(demand.start_at)||Date.parse(shift.end_at)>Date.parse(demand.end_at))) {
        problem(409,"班次必须位于同一门店的需求时段内。");
      }
    }
    function validateShift(shift:Shift, routeVerified=false, publishing=false) {
      validateDraft(shift);
      const demand=demands.find(row=>row.demand_id===shift.demand_id);
      if (demand?.required_qualification_id && !people().find(p=>p.dentist_id===shift.dentist_id)?.qualifications
          .some(q=>q.qualification_id===demand.required_qualification_id && (!q.valid_from||q.valid_from<=dateOf(shift.start_at))
            && (!q.valid_until||q.valid_until>=dateOf(shift.end_at)))) problem(409,"牙医资格未覆盖整个班次。");
      const published=shifts.filter(row=>row.shift_id!==shift.shift_id && row.dentist_id===shift.dentist_id && row.status==="PUBLISHED");
      if (published.some(row=>overlap(shift.start_at,shift.end_at,row.start_at,row.end_at))) {
        problem(409,"牙医已有重叠的已发布班次。");
      }
      const previous=published.filter(row=>Date.parse(row.end_at)<=Date.parse(shift.start_at))
        .sort((a,b)=>Date.parse(b.end_at)-Date.parse(a.end_at))[0];
      const following=published.filter(row=>Date.parse(row.start_at)>=Date.parse(shift.end_at))
        .sort((a,b)=>Date.parse(a.start_at)-Date.parse(b.start_at))[0];
      const gaps: number[]=[];
      if(previous&&previous.clinic_id!==shift.clinic_id) gaps.push(Date.parse(shift.start_at)-Date.parse(previous.end_at));
      if(following&&following.clinic_id!==shift.clinic_id) gaps.push(Date.parse(following.start_at)-Date.parse(shift.end_at));
      if(gaps.some(gap=>gap<3600000)) problem(409,"跨店班次需至少间隔 60 分钟。");
      if(gaps.length&&publishing&&!routeVerified) problem(409,"发布前须核对跨店路线并记录依据。");
    }
    const withActions=(row:Version)=>({...row,allowed_actions:[
      ...(row.status==="REVIEW"&&!row.review&&capability("HQ_PERFORMANCE_REVIEW")?["review"]:[]),
      ...(row.status==="REVIEW"&&row.review?.decision==="APPROVED"&&capability("HQ_PERFORMANCE_CONFIRM")?["confirm"]:[]),
    ]});
    const confirmed=(rows:Version[])=>rows.filter(row=>row.status==="CONFIRMED").at(-1);
    const periodInfo=(p:Period)=>{const rows=revisions.get(p.period_id)??[]; const current=confirmed(rows);
      return {...p,status:rows.at(-1)?.status??"OPEN",latest_confirmed_revision_no:current?.revision_no};};

    function bookingOptions(q: URLSearchParams) {
      const clinic = q.get("clinic_id"), doctor = q.get("dentist_id"), date = q.get("date");
      const project = standards.find(row => row.active && row.treatment_type_id === q.get("treatment_type_id"));
      if (!clinic || !date || !project?.default_slot_minutes || !operating(clinic)) return [];
      actor.authorize(q.has("appointment_id") ? coordinatorRoles : ["FRONT_DESK"],clinic);
      const duration = project.default_slot_minutes * 60_000;
      const preferred = q.get("preferred_start_at");
      const candidates = [];
      for (const shift of shifts.filter(row => row.status === "PUBLISHED" && row.clinic_id === clinic
        && wanted(doctor, row.dentist_id) && dateOf(row.start_at) === date)) {
        const dentist = people().find(p => p.dentist_id === shift.dentist_id && p.clinic_ids.includes(clinic));
        if (!dentist || (project.required_qualification_id && !dentist.qualifications.some(item =>
          item.qualification_id === project.required_qualification_id && (!item.valid_from || item.valid_from<=date)
          && (!item.valid_until || item.valid_until>=date)))) continue;
        const first = preferred ? Date.parse(preferred) : Date.parse(shift.start_at);
        const last = preferred ? first : Date.parse(shift.end_at) - duration;
        for (let start = first; start <= last; start += duration) {
          const start_at = new Date(start).toISOString(), end_at = new Date(start + duration).toISOString();
          if (start < Math.max(Date.parse(shift.start_at),Date.parse(sampleTime)) || start + duration > Date.parse(shift.end_at)) continue;
          if (previewAppointments.some(row => row.id !== q.get("appointment_id") && doctorId(row) === dentist.dentist_id && row.date === date
            && ["booked", "arrived", "treating"].includes(row.status) && overlap(start_at, end_at, appointmentStart(row),appointmentEnd(row)))) continue;
          const usable = resources.filter(chair=>chair.clinic_id===clinic && chair.chair_kind===project.required_chair_kind
            && chairFree(chair,start_at,end_at)).length;
          const booked = claims(clinic,project.required_chair_kind,q.get("appointment_id")??undefined)
            .filter(row=>overlap(start_at,end_at,row.start_at,row.end_at)).length;
          if (booked >= usable) continue;
          if ([...holds.values()].some(hold => hold.status === "HOLD" && hold.dentist_id === shift.dentist_id
            && Date.parse(hold.expires_at) > Date.now() && overlap(start_at, end_at, hold.start_at, hold.end_at))) continue;
          candidates.push({clinic_id:clinic, dentist_id:shift.dentist_id, dentist_name:dentist.name,
            shift_id:shift.shift_id, treatment_type_id:project.treatment_type_id, start_at, end_at});
        }
      }
      return candidates;
    }

    function sampleBilling(q: URLSearchParams, raw: string) {
      need("FRONT_DESK", q.get("clinic_id") ?? undefined);
      const term = raw.trim().toLowerCase();
      const filter = q.get("status");
      const items = previewAppointments.filter(row => row.status === "done" && wanted(q.get("clinic_id"), row.clinic)
        && wanted(q.get("date"), row.date) && capability("FRONT_DESK", row.clinic))
        .flatMap(row => {
          const bill = row.invoice ? bills[row.invoice] : undefined;
          const phone = registry.patient(row.clinic,row.patientId)?.phone ?? "";
          const visit = clinical.visit(row.id);
          if (term && phone !== term && ![row.patient, row.id, row.invoice ?? ""].some(value => value.toLowerCase().includes(term))) return [];
          const due = bill ? Math.max(0, Math.round((bill.received - bill.refunded - bill.due)*100)/100) : 0;
          const pending = bill?.pendingRefund ?? 0;
          const remaining = Math.max(0, due - pending);
          const state = !bill ? "WAITING_INVOICE" : pending ? "REFUND_PENDING" : due ? "REFUND_DUE"
            : !bill.outstanding ? "SETTLED" : bill.received > bill.refunded ? "PARTIAL_PAYMENT" : "WAITING_PAYMENT";
          if (filter && !(filter === "INVOICED" ? bill : filter === "REFUND_DUE" ? remaining : filter === state)) return [];
          if (!visit || !["COMPLETED","TERMINATED"].includes(visit.status)) return [];
          return [{visit_id:visit.visit_id, appointment_no:row.id, clinic_id:row.clinic, clinic_name:clinicName(row.clinic),
            ended_at:visit.ended_at ?? appointmentEnd(row), status:visit.status, invoice_id:row.invoice ?? null, invoice_no:row.invoice ?? null,
            patient_display:{name:row.patient, phone_tail:phone.slice(-4)}, billing_state:state,
            outstanding:bill?.outstanding.toFixed(2) ?? null, refund_remaining:remaining.toFixed(2), pending_refund:pending.toFixed(2)}];
        }).sort((left, right) => right.ended_at.localeCompare(left.ended_at) || right.visit_id.localeCompare(left.visit_id));
      const offset = Number(q.get("cursor") ?? "0");
      return {items:items.slice(offset, offset + 20), next_cursor:offset + 20 < items.length ? String(offset + 20) : null,
        summary:{total_records:items.length,waiting_invoice:items.filter(row=>row.billing_state==="WAITING_INVOICE").length,
          actionable_records:items.filter(row=>row.billing_state!=="SETTLED").length,
          outstanding:items.reduce((sum,row)=>sum+Number(row.outstanding??0),0).toFixed(2),
          refund_due:items.reduce((sum,row)=>sum+Number(row.refund_remaining),0).toFixed(2),
          pending_refund:items.reduce((sum,row)=>sum+Number(row.pending_refund),0).toFixed(2)}};
    }

    function operatingMetrics(items: ReportItem[], from: string, to: string, selectedClinics: string[]) {
      const dayExpense: Record<string, number> = {central: 240, river: 180};
      const materialRate = 0.26;
      const activeStates = new Set(["COMPLETED", "IN_TREATMENT", "CONFIRMED", "CHECKED_IN"]);
      const attendedStates = new Set(["COMPLETED", "IN_TREATMENT"]);
      const rateData = (numerator: number, denominator: number) => ({numerator, denominator,
        availability: denominator ? "AVAILABLE" : "NOT_APPLICABLE",
        value: denominator ? (numerator / denominator).toFixed(6) : null});
      const moneyValue = (value: number) => value.toFixed(2);
      const daysByClinic = new Map<string, Set<string>>();
      for (const item of items) {
        if (!daysByClinic.has(item.clinic_id)) daysByClinic.set(item.clinic_id, new Set());
        daysByClinic.get(item.clinic_id)!.add(item.service_date);
      }
      const clinicIds = selectedClinics.length ? selectedClinics : [...daysByClinic.keys()];
      const revenue = new Map<string, number>(), net = new Map<string, number>();
      const material = new Map<string, number>(), operating = new Map<string, number>();
      const attended = new Map<string, number>(), noShow = new Map<string, number>();
      const cancelled = new Map<string, number>(), unprocessed = new Map<string, number>();
      const visits = new Map<string, number>(), workMinutes = new Map<string, number>();
      const occupied = new Map<string, number>(), bookedByDentist = new Map<string, number>();
      const workload = new Map<string, {clinic_id: string; dentist_id: string; minutes: number; visits: number; revenue: number; material: number}>();
      const clinicIdsFor = (id: string) => clinicIds.includes(id);
      const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
      const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
      const dentistName = (id: string) => employees.find(employee => employee.employee_id === id)?.full_name ?? "牙医 " + id;
      for (const item of items) {
        if (!clinicIdsFor(item.clinic_id)) continue;
        const accrued = Number(item.accrued ?? 0);
        const dentist = item.dentist_id ?? "1";
        add(revenue, item.clinic_id, accrued);
        add(net, item.clinic_id, Number(item.received ?? 0) - Number(item.refunded ?? 0));
        add(material, item.clinic_id, accrued * materialRate);
        if (attendedStates.has(item.status)) {
          count(attended, item.clinic_id);
          count(visits, item.clinic_id);
          add(workMinutes, item.clinic_id, 30);
          add(occupied, item.clinic_id, 30);
          add(bookedByDentist, item.clinic_id + "|" + dentist, 30);
        }
        if (item.status === "NO_SHOW") count(noShow, item.clinic_id);
        if (item.status === "CANCELLED") count(cancelled, item.clinic_id);
        if (item.status === "CONFIRMED" || item.status === "CHECKED_IN") count(unprocessed, item.clinic_id);
        const key = item.clinic_id + "|" + dentist;
        if (!workload.has(key)) workload.set(key, {clinic_id: item.clinic_id, dentist_id: dentist, minutes: 0,
          visits: 0, revenue: 0, material: 0});
        const row = workload.get(key)!;
        if (attendedStates.has(item.status)) { row.minutes += 30; row.visits += 1; }
        row.revenue += accrued;
        row.material += accrued * materialRate;
      }
      for (const clinic of clinicIds) {
        const days = daysByClinic.get(clinic)?.size ?? 0;
        operating.set(clinic, days * (dayExpense[clinic] ?? 200));
      }
      const chairsByClinic = new Map<string, number>();
      for (const chair of resources) {
        if (chair.status !== "AVAILABLE") continue;
        chairsByClinic.set(chair.clinic_id, (chairsByClinic.get(chair.clinic_id) ?? 0) + 1);
      }
      const dentistsByClinic = new Map<string, number>();
      for (const person of people()) {
        for (const clinic of person.clinic_ids) dentistsByClinic.set(clinic, (dentistsByClinic.get(clinic) ?? 0) + 1);
      }
      const capacityByClinic = new Map<string, number>();
      const shiftByClinic = new Map<string, number>();
      for (const clinic of clinicIds) {
        const days = daysByClinic.get(clinic)?.size ?? 0;
        const chairs = chairsByClinic.get(clinic) ?? 0;
        capacityByClinic.set(clinic, days * chairs * 480);
        shiftByClinic.set(clinic, days * (dentistsByClinic.get(clinic) ?? 1) * 480);
      }
      const total = (map: Map<string, number>) => [...map.values()].reduce((sum, value) => sum + value, 0);
      const revenueTotal = total(revenue), materialTotal = total(material), operatingTotal = total(operating);
      const netProfit = revenueTotal - materialTotal - operatingTotal;
      const trendDays = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000;
      const granularity = trendDays <= 62 ? "day" : "month";
      const buckets: {key: string; label: string; start: string; end: string}[] = [];
      if (granularity === "day") {
        for (let offset = 0; offset <= trendDays; offset += 1) {
          const date = new Date(Date.parse(from + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
          buckets.push({key: date, label: date.slice(5), start: date, end: date});
        }
      } else {
        const cursor = new Date(Date.parse(from.slice(0, 7) + "-01T00:00:00Z"));
        while (cursor.toISOString().slice(0, 10) <= to) {
          const key = cursor.toISOString().slice(0, 7);
          buckets.push({key, label: key.slice(0, 4) + "年" + key.slice(5) + "月", start: key + "-01", end: key + "-31"});
          cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        }
      }
      const bucketOf = (date: string) => granularity === "day" ? date : date.slice(0, 7);
      const points = new Map(buckets.map(bucket => [bucket.key, {period: bucket.key, label: bucket.label,
        revenue: 0, material_cost: 0, operating_cost: 0, net_profit: 0, appointments: 0, attended: 0, visits: 0, work_minutes: 0}]));
      const expenseDays = new Set<string>();
      for (const item of items) {
        if (!clinicIdsFor(item.clinic_id)) continue;
        const point = points.get(bucketOf(item.service_date));
        if (!point) continue;
        const accrued = Number(item.accrued ?? 0);
        point.revenue += accrued;
        point.material_cost += accrued * materialRate;
        point.appointments += 1;
        if (attendedStates.has(item.status)) { point.attended += 1; point.visits += 1; point.work_minutes += 30; }
        const expenseKey = bucketOf(item.service_date) + "|" + item.clinic_id + "|" + item.service_date;
        if (!expenseDays.has(expenseKey)) {
          expenseDays.add(expenseKey);
          point.operating_cost += dayExpense[item.clinic_id] ?? 200;
        }
      }
      for (const point of points.values()) point.net_profit = point.revenue - point.material_cost - point.operating_cost;
      const clinics = clinicIds.map(clinic => {
        const dayCount = daysByClinic.get(clinic)?.size ?? 0;
        const attendedCount = attended.get(clinic) ?? 0;
        const appointments = items.filter(item => item.clinic_id === clinic).length;
        const occupiedMinutes = occupied.get(clinic) ?? 0;
        const capacity = capacityByClinic.get(clinic) ?? 0;
        return {clinic_id: clinic, clinic_name: clinicName(clinic),
          revenue: moneyValue(revenue.get(clinic) ?? 0), net_received: moneyValue(net.get(clinic) ?? 0),
          material_cost: moneyValue(material.get(clinic) ?? 0), operating_cost: moneyValue(operating.get(clinic) ?? 0),
          net_profit: moneyValue((revenue.get(clinic) ?? 0) - (material.get(clinic) ?? 0) - (operating.get(clinic) ?? 0)),
          appointments, attended: attendedCount, no_show: noShow.get(clinic) ?? 0,
          patient_cancelled: cancelled.get(clinic) ?? 0, unprocessed: unprocessed.get(clinic) ?? 0,
          attendance_rate: rateData(attendedCount, appointments),
          visits: visits.get(clinic) ?? 0, treatments: attendedCount,
          work_minutes: moneyValue(workMinutes.get(clinic) ?? 0), work_hours: ((workMinutes.get(clinic) ?? 0) / 60).toFixed(2),
          chair_utilization: rateData(occupiedMinutes, capacity),
          dentist_utilization: rateData(occupiedMinutes, shiftByClinic.get(clinic) ?? 0),
          _days: dayCount};
      });
      const workloadList = [...workload.values()].map(row => ({
        clinic_id: row.clinic_id, clinic_name: clinicName(row.clinic_id),
        dentist_id: row.dentist_id, dentist_name: dentistName(row.dentist_id),
        minutes: row.minutes.toFixed(2), hours: (row.minutes / 60).toFixed(2),
        visits: row.visits, treatments: row.visits,
        revenue: moneyValue(row.revenue), material_cost: moneyValue(row.material),
      })).sort((left, right) => Number(right.minutes) - Number(left.minutes));
      const chairDetails = clinics.map(row => ({clinic_id: row.clinic_id, clinic_name: row.clinic_name,
        occupied_minutes: (occupied.get(row.clinic_id) ?? 0).toFixed(0),
        capacity_minutes: (capacityByClinic.get(row.clinic_id) ?? 0).toFixed(0),
        active_chairs: chairsByClinic.get(row.clinic_id) ?? 0, utilization: row.chair_utilization}));
      const dentistDetails = [...workload.values()].map(row => {
        const dentistDays = daysByClinic.get(row.clinic_id)?.size ?? 0;
        const dentistShift = dentistDays * 480;
        return {clinic_id: row.clinic_id, clinic_name: clinicName(row.clinic_id),
        dentist_id: row.dentist_id, dentist_name: dentistName(row.dentist_id),
        shift_minutes: dentistShift.toFixed(0),
        booked_minutes: (bookedByDentist.get(row.clinic_id + "|" + row.dentist_id) ?? 0).toFixed(0),
        work_minutes: row.minutes.toFixed(0),
        utilization: rateData(bookedByDentist.get(row.clinic_id + "|" + row.dentist_id) ?? 0, dentistShift)};
      });
      const revenueDetails = items.filter(item => Number(item.accrued ?? 0) > 0).map(item => ({
        clinic_id: item.clinic_id, clinic_name: clinicName(item.clinic_id),
        dentist_id: item.dentist_id ?? "", dentist_name: dentistName(item.dentist_id ?? "1"),
        invoice_no: item.invoice_no ?? "", visit_id: item.visit_id ?? "", service_date: item.service_date,
        amount: moneyValue(Number(item.accrued ?? 0)), accrued: moneyValue(Number(item.accrued ?? 0)),
      }));
      const materialDetails = revenueDetails.map(row => ({...row, material_name: "综合耗材", quantity: "1.000",
        unit_cost: moneyValue(Number(row.amount) * materialRate), amount: moneyValue(Number(row.amount) * materialRate)}));
      const operatingDetails = clinicIds.flatMap(clinic => [...(daysByClinic.get(clinic) ?? [])].map(day => ({
        clinic_id: clinic, clinic_name: clinicName(clinic), period: day, expense_category: "日摊经营费用",
        scope: "SHARED", recorded_amount: moneyValue(dayExpense[clinic] ?? 200),
        amount: moneyValue(dayExpense[clinic] ?? 200)})));
      const visitDetails = items.filter(item => attendedStates.has(item.status)).map(item => ({
        visit_id: item.visit_id ?? "V-" + item.appointment_no, clinic_id: item.clinic_id, clinic_name: clinicName(item.clinic_id),
        dentist_id: item.dentist_id ?? "", dentist_name: dentistName(item.dentist_id ?? "1"),
        status: item.status, ended_at: item.service_date + "T12:00:00+08:00",
      }));
      const workDetails = visitDetails.map(row => ({work_id: "W-" + row.visit_id, visit_id: row.visit_id,
        clinic_id: row.clinic_id, clinic_name: row.clinic_name, dentist_id: row.dentist_id, dentist_name: row.dentist_name,
        started_at: row.ended_at, minutes: "30.00"}));
      const categories = ["租赁", "设备维护", "院感耗材", "行政支持"];
      const weights = [0.4, 0.24, 0.2, 0.16];
      const expenseCategories = categories.map((category, index) => ({category, amount: moneyValue(operatingTotal * weights[index])}));
      const quarters = new Set<string>();
      const cursor = new Date(Date.parse(from.slice(0, 7) + "-01T00:00:00Z"));
      while (cursor.toISOString().slice(0, 10) <= to) {
        quarters.add(cursor.getUTCFullYear() + "-" + (Math.floor(cursor.getUTCMonth() / 3) + 1));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      const report = {
        operations: {revenue: moneyValue(revenueTotal), net_received: moneyValue(total(net)),
          material_cost: moneyValue(materialTotal), operating_cost: moneyValue(operatingTotal),
          net_profit: moneyValue(netProfit), profit_margin: rateData(netProfit, revenueTotal),
          expense_categories: expenseCategories,
          expense_periods: [...quarters].map(key => ({period_id: "synthetic-" + key, year: Number(key.slice(0, 4)),
            quarter: Number(key.slice(5))}))},
        workload: {total_minutes: total(workMinutes).toFixed(0), total_hours: (total(workMinutes) / 60).toFixed(2),
          dentists: workloadList},
        resources: {
          active_chairs: [...chairsByClinic.values()].reduce((sum, value) => sum + value, 0),
          chair_occupied_minutes: total(occupied).toFixed(0),
          chair_capacity_minutes: total(capacityByClinic).toFixed(0),
          chair_utilization: rateData(total(occupied), total(capacityByClinic)),
          open_chair_days: new Set(items.map(item => item.service_date)).size,
          dentist_shift_minutes: total(shiftByClinic).toFixed(0),
          dentist_booked_minutes: total(occupied).toFixed(0),
          dentist_work_minutes: total(workMinutes).toFixed(0),
          dentist_utilization: rateData(total(occupied), total(shiftByClinic)),
          work_utilization: rateData(total(workMinutes), total(shiftByClinic)),
        },
        clinics: clinics.map(({_days, ...row}) => row),
        trend: {granularity, points: [...points.values()].map(point => ({...point,
          revenue: moneyValue(point.revenue), material_cost: moneyValue(point.material_cost),
          operating_cost: moneyValue(point.operating_cost), net_profit: moneyValue(point.net_profit),
          work_minutes: point.work_minutes.toFixed(0)}))},
        sources: {operations: "合成收入按主单应计，耗材按固定比例估算，经营费用按开放日摊入。",
          workload: "合成牙医实际计时。", resources: "合成牙椅、班次与预约占用。"},
        details: {revenue: revenueDetails, material_cost: materialDetails, operating_cost: operatingDetails,
          net_profit: clinics.map(row => ({clinic_id: row.clinic_id, clinic_name: row.clinic_name,
            revenue: row.revenue, material_cost: row.material_cost, operating_cost: row.operating_cost, net_profit: row.net_profit})),
          visits: visitDetails, work_minutes: workDetails, workload: workloadList,
          chair_utilization: chairDetails, dentist_utilization: dentistDetails},
      };
      return report;
    }

    function dispatch(path:string, method:string, b:Body, options:{queueSearch?:string;actionKey?:string}):unknown {
      const [route,search]=path.split("?");
      const q=new URLSearchParams(search);
      const selected=q.get("clinic_id");
      const read=method==="GET";
      if(route==="/billing/queue") return sampleBilling(q, options.queueSearch ?? "");
      if(route==="/booking/options") return {items:bookingOptions(q)};
      const result = registry.dispatchPatients(route,q,read,b,actor)
        ?? registry.dispatchAppointment(route,q,read,b,actor,bookingOptions)
        ?? clinical.dispatch(route,q,method,b,actor);
      if (result !== undefined) return result;
      if (route === "/workbench/alerts") {
        const rows = registry.rows(q,actor);
        return {schedule:rows.some(row => row.status==="booked"),
          clinical:capability("DENTIST") && rows.some(row => row.status==="arrived" || row.status==="treating"),
          billing:capability("FRONT_DESK") && rows.some(row => row.status==="done" && (!row.invoice || bills[row.invoice]?.outstanding)),
          reconciliation:false, corrections:false};
      }
      const assistantRoute = "/reports/operations/assistant";
      if (route.startsWith(assistantRoute + "/")) {
        need("HQ_OPERATIONS_QUERY");
        return assistant(route.slice(assistantRoute.length),method,q,b,
          query => dispatch("/reports/operations?" + query,"GET",{},{}),options.actionKey);
      }
      if (route === "/holds/by-action") {
        const prior = holdActions.get(options.actionKey ?? "");
        if (!prior || prior.clinic_id !== selected || prior.patient_id !== q.get("patient_id")) problem(404, "暂无该样例占位。");
        need("FRONT_DESK", prior.clinic_id);
        return prior;
      }
      if (route === "/holds" && !read) {
        const clinic = String(b.clinic_id);
        if (!registry.patient(clinic,String(b.patient_id))) problem(404,"找不到该门店患者。");
        const incoming = new Date(String(b.start_at));
        const date = shanghaiDate(incoming);
        const prefer = new URLSearchParams({clinic_id:clinic, date, dentist_id:String(b.dentist_id),
          treatment_type_id:String(b.treatment_type_id), preferred_start_at:incoming.toISOString()});
        const selectedSlot = bookingOptions(prefer).find(item => item.shift_id === String(b.shift_id) && item.end_at === b.end_at);
        if (!selectedSlot) problem(409, "该样例时段已不可用，请重新查询。");
        const hold = {...selectedSlot, patient_id:String(b.patient_id), claim_id:id(), status:"HOLD",
          server_time:new Date().toISOString(), expires_at:new Date(Date.now() + 300_000).toISOString(),
          specialRequirement:typeof b.special_requirement === "string" ? b.special_requirement : undefined,
          payment:{deposit_id:id(), amount:"50.00", status:"NOT_STARTED"}};
        holds.set(hold.claim_id, hold);
        if (options.actionKey) holdActions.set(options.actionKey, hold);
        return hold;
      }
      const holdRoute = route.match(/^\/holds\/(\d+)(\/release)?$/);
      if (holdRoute) {
        const hold = holds.get(holdRoute[1]);
        if (!hold) problem(404, "暂无该样例占位。");
        need("FRONT_DESK", hold.clinic_id);
        if (holdRoute[2] && hold.status === "HOLD") hold.status = "RELEASED";
        return hold;
      }
      const depositRoute = route.match(/^\/deposit-payments\/(\d+)(\/simulate)?$/);
      if (depositRoute) {
        const hold = [...holds.values()].find(row => row.payment.deposit_id === depositRoute[1]);
        if (!hold) problem(404, "暂无该样例预约金。");
        need("FRONT_DESK", hold.clinic_id);
        if (depositRoute[2] && hold.status !== "CONFIRMED") {
          if (hold.status !== "HOLD" || Date.parse(hold.expires_at) <= Date.now()) problem(409, "样例占位已失效。");
          if(!operating(hold.clinic_id)) problem(409,"门店已停用，请重新选择预约。");
          const name = registry.patient(hold.clinic_id,hold.patient_id)?.full_name;
          if (!name) problem(404, "暂无该样例患者。");
          hold.appointment_id = "ADC-PREVIEW-" + id();
          hold.appointment_no = hold.appointment_id;
          hold.status = "CONFIRMED"; hold.payment.status = "PAID";
          registry.establishDeposit(hold.appointment_id,hold.claim_id,hold.payment);
          if (hold.specialRequirement) specialRequirements.set(hold.appointment_id,hold.specialRequirement);
          deposits.push({appointment_id:hold.appointment_id,deposit_id:hold.payment.deposit_id,claim_id:hold.claim_id,
            amount:hold.payment.amount,paid_at:sampleTime,clinic_id:hold.clinic_id});
          previewAppointments.push({id:hold.appointment_id, date:shanghaiDate(new Date(hold.start_at)),
            time:shanghaiTime(new Date(hold.start_at)), clinic:hold.clinic_id,
            minutes:(Date.parse(hold.end_at)-Date.parse(hold.start_at))/60_000,
            doctor:hold.dentist_name,dentistId:hold.dentist_id,treatmentId:hold.treatment_type_id,
            patient:name, patientId:hold.patient_id, status:"booked",
            service:standards.find(project=>project.treatment_type_id === hold.treatment_type_id)?.treatment_name ?? "口腔检查"});
        }
        return {...hold.payment, claim_status:hold.status, appointment_id:hold.appointment_id, appointment_no:hold.appointment_no};
      }
      const dailyRoles = ["HQ_SCHEDULER","CLINIC_MANAGER","FRONT_DESK","DENTIST"];
      if (route==="/clinics") {
        const scope=[...dailyRoles,"HQ_OPERATIONS_QUERY"];
        actor.authorize(scope);
        return {items:branches.filter(row=>operating(row.clinic_id) && actor.allowed(scope,row.clinic_id))};
      }
      if(route==="/qualifications") return {items:qualifications.map(({qualification_id,qualification_code,qualification_name})=>
        ({qualification_id,code:qualification_code,name:qualification_name}))};
      if(route==="/schedule/dentists") {
        actor.authorize(dailyRoles,selected??undefined);
        return {items:people().flatMap(row=>{
          const clinic_ids=row.clinic_ids.filter(clinic=>wanted(selected,clinic) &&
            (actor.allowed(["HQ_SCHEDULER","CLINIC_MANAGER","FRONT_DESK"],clinic)
              || (row.dentist_id===actor.dentist() && actor.allowed(["DENTIST"],clinic))));
          return clinic_ids.length ? [{...row,clinic_ids}] : [];
        })};
      }
      if(route==="/schedule/board") {
        actor.authorize(dailyRoles,selected??undefined);
        const dayspan = (start:string,end:string) => end > (q.get("date_from") ?? "") && start <= (q.get("date_to") ?? "9999");
        return {shifts:shifts.filter(row=>scheduleVisible(row,q.get("view")==="day")&&wanted(selected,row.clinic_id)
          && wanted(q.get("dentist_id"),row.dentist_id) && dayspan(dateOf(row.start_at), addDays(dateOf(row.end_at),1))),
          ...(q.get("view")==="day" && selected ? {unavailable:dayOutages(selected,at(q.get("date_from")??sampleDate,"00:00"),
            at(addDays(q.get("date_to")??sampleDate,1),"00:00"))} : {}),
          ...(q.get("view")==="week" ? sampleShiftInsights({
            shifts, demands, visible: row=>scheduleVisible(row,false),
            canReadDemand: clinic=>actor.allowed(["HQ_SCHEDULER","CLINIC_MANAGER"],clinic),
            canQualify: (shift,demand) => !demand.required_qualification_id
              || (people().find(row=>row.dentist_id===shift.dentist_id)?.qualifications.some(qualification=>
                qualification.qualification_id===demand.required_qualification_id
                && (!qualification.valid_from || qualification.valid_from<=dateOf(new Date(Math.max(Date.parse(shift.start_at),Date.parse(demand.start_at))).toISOString()))
                && (!qualification.valid_until || qualification.valid_until>=dateOf(new Date(Math.min(Date.parse(shift.end_at),Date.parse(demand.end_at))-1).toISOString()))) ?? false),
            clinicId:selected,dentistId:q.get("dentist_id"),dateFrom:q.get("date_from"),dateTo:q.get("date_to"),
          }) : {}),
          appointments:registry.rows(q,actor).filter(row=>dayspan(row.date,addDays(row.date,1))).map(row=>{
            const view = registry.projection(row,actor);
            return {appointment_id:row.id,appointment_no:row.id,clinic_id:row.clinic,dentist_id:doctorId(row),
              start_at:view.start_at,end_at:view.end_at,status:view.status,patient_display:view.patient_display?.name};
          })};
      }
      if(route==="/shift-demands"){
        if(read) {
          actor.authorize(["HQ_SCHEDULER","CLINIC_MANAGER"],selected??undefined);
          return {items:demands.filter(row=>wanted(selected,row.clinic_id) && actor.allowed(["HQ_SCHEDULER","CLINIC_MANAGER"],row.clinic_id))};
        }
        const clinic_id=String(b.clinic_id); need("CLINIC_MANAGER",clinic_id);
        if(!operating(clinic_id)) problem(409,"门店已停用。");
        const start_at=String(b.start_at), end_at=String(b.end_at);
        ensureDates(start_at,end_at);
        if(!Number.isInteger(b.required_count)||Number(b.required_count)<1) problem(400,"所需人数必须是正整数。");
        const item={demand_id:id(),clinic_id,start_at,end_at,required_qualification_id:b.required_qualification_id?String(b.required_qualification_id):null,required_count:Number(b.required_count)};
        demands.push(item);return item;
      }
      if (route==="/shifts/batch" && method==="POST") {
        return runSampleShiftBatch(b, {
          shifts, need, validateShift, validateDraft, nextId:id, problem,
          canReuse: row => capability("HQ_SCHEDULER",row.clinic_id) && operating(row.clinic_id)
            && people().some(person=>person.dentist_id===row.dentist_id && person.clinic_ids.includes(row.clinic_id)),
        });
      }
      const shiftRoute=route.match(/^\/shifts(?:\/(\d+))?(?:\/([\w-]+))?$/);
      if(shiftRoute){
        const [,shift_id,action]=shiftRoute;
        const row=shifts.find(x=>x.shift_id===shift_id);
        if(shift_id&&!row) problem(404,"班次不存在。");
        if(!action){
          const clinic_id=String(b.clinic_id),dentist_id=String(b.dentist_id);
          need("HQ_SCHEDULER",clinic_id);
          if(row&&(!["DRAFT","REJECTED"].includes(row.status)||row.status!==b.expected_status||!String(b.reason??"").trim())) problem(409,"当前班次不能调整，请刷新后核对状态。");
          const start_at=String(b.start_at),end_at=String(b.end_at);
          ensureDates(start_at,end_at);
          const item:BoardShift={rejection_reason:undefined,shift_id:shift_id??id(),clinic_id,dentist_id,start_at,end_at,status:"DRAFT",
            demand_id:b.demand_id?String(b.demand_id):undefined};
          if(row) need("HQ_SCHEDULER",row.clinic_id);
          validateDraft(item);
          if(row) Object.assign(row,item); else shifts.push(item);
          return item;
        }
        if(!row) problem(404,"班次不存在。");
        if(action==="respond"){
          need("DENTIST",row.clinic_id);
          if(row.dentist_id!==sampleRoles[role].employee) problem(403,"牙医只可处理本人班次。");
          if(row.status!=="PENDING"||!["ACCEPTED","REJECTED"].includes(String(b.decision))||
            (b.decision==="REJECTED"&&!String(b.reason??"").trim())) problem(409,"请核对班次状态并填写拒绝原因。");
          row.status=String(b.decision);
          row.rejection_reason=row.status==="REJECTED"?String(b.reason):undefined;
          return row;
        }
        if(action==="affected-appointments"){
          if(!capability("CLINIC_MANAGER",row.clinic_id)) need("HQ_SCHEDULER",row.clinic_id);
          return {items:appointmentRows(row.clinic_id,row.start_at,row.end_at,row.dentist_id)};
        }
        need("HQ_SCHEDULER",row.clinic_id);
        if(action==="submit"&&row.status==="DRAFT"){
          validateShift(row);row.status="PENDING";return row;
        }
        if(action==="publish"&&row.status==="ACCEPTED"){
          validateShift(row,b.route_feasible===true&&Boolean(String(b.evidence_ref??"").trim()),true);
          row.status="PUBLISHED";return row;
        }
        if(action==="withdraw"&&row.status==="PUBLISHED"&&String(b.reason??"").trim()){
          const affected=appointmentRows(row.clinic_id,row.start_at,row.end_at,row.dentist_id);
          if(affected.length) throw new ApiError(409,{code:"SCHEDULE_CONFLICT",message:"需先协调受影响预约。",details:{appointments:affected}});
          row.status="CANCELLED";return row;
        }
        problem(409,"当前班次状态不允许此项操作。");
      }
      const chairList=route.match(/^\/clinics\/(\w+)\/chairs$/);
      if(chairList) return {items:resources.filter(x=>x.clinic_id===chairList[1])};
      const chairEdit=route.match(/^\/chairs\/(\d+)\/unavailability$/);
      if(chairEdit){
        const chair=resources.find(x=>x.chair_id===chairEdit[1]);
        if(!chair) problem(404,"找不到牙椅。");
        need("CLINIC_MANAGER",chair.clinic_id);
        const start_at=String(b.start_at),end_at=String(b.end_at),reason=String(b.reason??"").trim();
        ensureDates(start_at,end_at);
        if(!reason) problem(400,"请填写停用原因。");
        chair.unavailability.push({unavailability_id:id(),start_at,end_at,reason});
        return {appointments_to_review:appointmentRows(chair.clinic_id,start_at,end_at)};
      }
      const masterResult=master.dispatch(route,method,b,{admin:capability("HQ_ACCESS_ADMIN"),
        catalog:identity(role).role_clinic_ids?.HQ_CATALOG===null});
      if(masterResult!==undefined) return masterResult;
      if(route==="/admin/access"){
        need("HQ_ACCESS_ADMIN");
        return {clinics:branches,
          employees:employees.map(({home_clinic_id,...employee}) => ({
            ...employee,home_clinic:homeClinic(home_clinic_id),can_manage_profile:employee.employee_id!==sampleRoles[role].employee,
            permissions:[
              ...employee.grants.map(grant => ({...grant,managed_by_deployment:false})),
              ...(globalStaffRoles.get(employee.employee_id) ?? []).map(role_code =>
                ({role_code,clinic_id:null,managed_by_deployment:true})),
            ],
          })),
          roles:editable.map(role_code => ({role_code,role_name:roleNames[role_code]}))};
      }
      const admin=route.match(/^\/admin\/access\/employees\/(\d+)\/(grants|account-status|history|profile)$/);
      if(admin){
        need("HQ_ACCESS_ADMIN");
        const employee=employees.find(e=>e.employee_id===admin[1]);
        if(!employee) problem(404,"找不到员工。");
        if(admin[2]==="history") return {items:audits.get(employee.employee_id)??[]};
        const reason=String(b.reason??"").trim(),isGrant=admin[2]==="grants",isProfile=admin[2]==="profile";
        if(!reason) problem(400,"请填写变更原因。");
        if(isProfile ? employee.employee_id===sampleRoles[role].employee
          : isGrant ? !employee.can_manage_grants : !employee.can_manage_account) problem(403,"该目标由部署维护。");
        let before:Body,after:Body;
        if(isProfile){
          const job_code = b.job_code as JobCode, home_clinic_id = b.home_clinic_id === null ? null : String(b.home_clinic_id);
          if (!Object.hasOwn(jobLabels,job_code) || (job_code === "HEADQUARTERS" ? home_clinic_id !== null : !homeClinic(home_clinic_id)))
            problem(400,"请核对岗位和所属机构。");
          if (b.expected_job_code !== employee.job_code || b.expected_home_clinic_id !== employee.home_clinic_id)
            problem(409,"资料已更新，请重新查询。");
          if (job_code === employee.job_code && home_clinic_id === employee.home_clinic_id)
            problem(400,"请选择需要变更的岗位资料。");
          before = {job_code:employee.job_code,home_clinic_id:employee.home_clinic_id};
          Object.assign(employee,{job_code,home_clinic_id});
          after = {job_code,home_clinic_id,reason};
        }else if(isGrant){
          const clinic_id=String(b.clinic_id),role_code=String(b.role_code);
          if(!editable.includes(role_code)||!branches.some(c=>c.clinic_id===clinic_id)) problem(403,"该角色或门店不可授权。");
          const matches=(g:{role_code:string;clinic_id:string})=>g.clinic_id===clinic_id&&g.role_code===role_code;
          const granted=employee.grants.some(matches);
          if(granted!==b.expected_granted||granted===b.granted) problem(409,"资料已更新，请重新查询。");
          employee.grants=b.granted?[...employee.grants,{clinic_id,role_code}]:employee.grants.filter(g=>!matches(g));
          before={clinic_id,role_code,granted};after={clinic_id,role_code,granted:b.granted,reason};
        }else{
          if(employee.account_status!==b.expected_status||!["ACTIVE","INACTIVE"].includes(String(b.status))||employee.account_status===b.status) problem(409,"资料已更新，请重新查询。");
          before={status:employee.account_status};employee.account_status=String(b.status);after={status:employee.account_status,reason};
        }
        const record={audit_id:id(),action:isProfile?"EMPLOYEE_PROFILE_CHANGED":isGrant?"EMPLOYEE_SCOPE_CHANGED":"EMPLOYEE_ACCOUNT_STATUS_CHANGED",
          occurred_at:new Date().toISOString(),actor_account_id:sampleRoles[role].employee,before,after};
        audits.set(employee.employee_id,[record,...(audits.get(employee.employee_id)??[])]);
        return {employee_id:employee.employee_id};
      }
      if(route==="/performance/periods"){
        if(read) return {items:periods.map(periodInfo)};
        need("HQ_PERFORMANCE_CALCULATE");
        const year=Number(b.year),quarter=Number(b.quarter);
        if(!Number.isInteger(year)||!Number.isInteger(quarter)||year<2020||quarter<1||quarter>4) problem(400,"请选择有效季度。");
        const old=periods.find(p=>p.year===year&&p.quarter===quarter);
        if(old) return periodInfo(old);
        const created={period_id:id(),year,quarter};
        periods.unshift(created);revisions.set(created.period_id,[]);return periodInfo(created);
      }
      const quarter=route.match(/^\/performance\/periods\/(\d+)(?:\/(calculate|revisions)(?:\/(\d+)(?:\/(review|confirm))?)?)?$/);
      if(quarter){
        const [,period_id,action,revision_no,write]=quarter;
        const p=periods.find(row=>row.period_id===period_id);
        if(!p) problem(404,"核算期间不存在。");
        const rows=revisions.get(period_id)!;
        const last=confirmed(rows),work=rows.at(-1);
        const calculable=!last || Boolean(work&&work.status!=="CONFIRMED");
        if(!action) return {...periodInfo(p),latest_confirmed:last&&withActions(last),workspace:work&&withActions(work),
          allowed_actions:capability("HQ_PERFORMANCE_CALCULATE")&&calculable?["calculate"]:[]};
        if(action==="calculate"){
          need("HQ_PERFORMANCE_CALCULATE");
          if(!calculable) problem(409,"请先完成当前版本的复核。");
          const item=version(period_id,work?.revision_no??1,"REVIEW",101460,
            expenses.filter(expense=>expense.period_id===period_id).reduce((sum,expense)=>sum+Number(expense.amount),0),rows[0]?.company);
          if(work) rows[rows.length-1]=item; else rows.push(item);
          return withActions(item);
        }
        if(!revision_no) return {items:rows.map(withActions)};
        const row=rows.find(r=>r.revision_no===Number(revision_no));
        if(!row) problem(404,"核算版本不存在。");
        if(write==="review"){
          need("HQ_PERFORMANCE_REVIEW");
          if(!withActions(row).allowed_actions.includes("review")||!String(b.reason??"").trim()
            ||!["APPROVED","REJECTED"].includes(String(b.decision))) problem(409,"当前版本不能提交复核。");
          row.review={decision:String(b.decision),reason:String(b.reason),reviewer_id:sampleRoles[role].employee};
          if(b.decision==="REJECTED") row.status="RETURNED";
        }
        if(write==="confirm"){
          need("HQ_PERFORMANCE_CONFIRM");
          if(!withActions(row).allowed_actions.includes("confirm")) problem(409,"请先复核通过。");
          row.status="CONFIRMED";row.confirmed_by=sampleRoles[role].employee;row.confirmed_at=new Date().toISOString();
        }
        return withActions(row);
      }
      if(route==="/expenses"){
        if(read) return {items:expenses.filter(x=>wanted(selected,x.clinic_id)&&wanted(q.get("period_id"),x.period_id))};
        const clinic_id=String(b.clinic_id);need("CLINIC_MANAGER",clinic_id);
        if(confirmed(revisions.get(String(b.period_id))??[])) problem(409,"已确认季度不能再登记费用。");
        if(!b.expense_category||!b.evidence_ref||!finite(b.amount)||Number(b.amount)<0
          ||!periods.some(x=>x.period_id===b.period_id)) problem(400,"请核对费用内容、金额及季度。");
        const item={expense_id:id(),clinic_id,period_id:String(b.period_id),expense_category:String(b.expense_category),
          scope:String(b.scope),amount:Number(b.amount).toFixed(2),evidence_ref:String(b.evidence_ref),dentist_id:b.dentist_id};
        expenses.push(item);return item;
      }
      const standard=route.match(/^\/catalog\/treatments(?:\/(\d+))?(\/prices)?$/);
      if(standard){
        const [,treatmentId,isPrices]=standard;
        const row=standards.find(x=>x.treatment_type_id===treatmentId);
        if(!isPrices&&read) return {items:standards};
        if(isPrices&&treatmentId&&row){
          const old=prices.get(treatmentId)??[];
          if(read) return {items:old};
          need("HQ_CATALOG");
          const effective_from=String(b.effective_from??""),effective_to=b.effective_to?String(b.effective_to):null;
          const replace=old.find(p=>p.price_id===b.replace_price_id);
          const replacement=b.replace_effective_to?String(b.replace_effective_to):null;
          if(!effective_from||!finite(b.unit_price)||Number(b.unit_price)<0||(effective_to&&effective_to<=effective_from)
            ||(replace&&(!replacement||replacement<=replace.effective_from))) problem(400,"请核对价格和生效日期。");
          if(old.some(p=>p.effective_from<(effective_to??"9999")&&effective_from<((p===replace?replacement:p.effective_to)??"9999"))) problem(409,"价格生效区间重叠。");
          if(replace) replace.effective_to=replacement;
          const result={price_id:id(),unit_price:Number(b.unit_price).toFixed(2),effective_from,effective_to};
          prices.set(treatmentId,[result,...old]);row.current_unit_price=result.unit_price;return result;
        }
        need("HQ_CATALOG");
        if(treatmentId&&!row) problem(404,"找不到项目。");
        const treatment_code=String(b.treatment_code??"").trim();
        if(!treatment_code||!b.treatment_name||!b.standard_unit||standards.some(x=>x!==row&&x.treatment_code===treatment_code)) problem(400,"请核对项目内容及唯一编码。");
        const result={...b,treatment_code,treatment_type_id:row?.treatment_type_id??id(),current_unit_price:row?.current_unit_price??null} as typeof standards[number];
        if(row) Object.assign(row,result);else standards.push(result);
        return result;
      }
      if(route==="/reports/operations"){
        need("HQ_OPERATIONS_QUERY");
        const date_from=q.get("date_from")??"",date_to=q.get("date_to")??"";
        const clinicFilter=q.get("clinic_ids")?.split(",") ?? [];
        const dentist_ids=q.get("dentist_ids")?.split(",").filter(Boolean) ?? [];
        const selectedClinics=branches.filter(branch=>(!clinicFilter.length || clinicFilter.includes(branch.clinic_id))
          && capability("HQ_OPERATIONS_QUERY",branch.clinic_id)).map(branch=>branch.clinic_id);
        const inWindow = (date:string, clinic:string) => selectedClinics.includes(clinic)
          && date >= date_from && date <= date_to;
        const historical: ReportItem[] = dentist_ids.length ? [] : dailyFacts.flatMap(day=>{
          const date = "2026-"+day.day;
          if (date >= sampleDate || !inWindow(date,day.clinic)) return [];
          const doctors = day.clinic === "central" ? ["1","2"] : ["3","13"];
          const dayTotal = 520 + ((day.day.charCodeAt(3) + day.day.charCodeAt(4) * 3 + (day.clinic === "river" ? 4 : 0)) % 8) * 90;
          return Array.from({length:day.total},(_,i)=>({appointment_no:"ADC-RPT-"+day.clinic+"-"+day.day+"-"+(i+1),
            clinic_id:day.clinic,dentist_id:doctors[i%doctors.length],service_date:date,minutes:30,
            status:i<day.arrived?"COMPLETED":i<day.arrived+day.unresolved?"CONFIRMED":"NO_SHOW",
            ...(i<day.arrived ? {received:dayTotal/day.arrived,accrued:dayTotal/day.arrived} : {})}));
        });
        const current: ReportItem[] = previewAppointments.filter(row=>inWindow(row.date,row.clinic)
          && (!dentist_ids.length || dentist_ids.includes(doctorId(row)))).map(row=>{
          const bill = row.invoice ? bills[row.invoice] : undefined;
          return {appointment_no:row.id,clinic_id:row.clinic,dentist_id:doctorId(row),service_date:row.date,minutes:30,
            status:appointmentStates[row.status],visit_id:clinical.visitIdForAppointment(row.id),
            ...(bill ? {invoice_no:row.invoice,accrued:bill.due,received:bill.received,refunded:bill.refunded,outstanding:bill.outstanding} : {})};
        });
        const items = [...historical,...current];
        const operating = operatingMetrics(items, date_from, date_to, selectedClinics);
        const {details: operatingDetails, ...operatingReport} = operating;
        const count = (rows:ReportItem[], states:string[]) => rows.filter(item=>states.includes(item.status)).length;
        const counts = (rows:ReportItem[]) => ({attended:count(rows,["COMPLETED","IN_TREATMENT"]),
          unprocessed:count(rows,["CONFIRMED","CHECKED_IN"]), no_show:count(rows,["NO_SHOW"]),
          patient_cancelled:count(rows,["CANCELLED"]),clinic_cancelled:0});
        const sum = (key:"accrued"|"received"|"refunded"|"outstanding") =>
          items.reduce((total,row)=>total+(row[key] ?? 0),0);
        const fact=counts(items), completed=count(items,["COMPLETED"]);
        const rate=(numerator:number,denominator:number)=>({numerator,denominator,
          value:denominator?(numerator/denominator).toFixed(5):null,availability:denominator?"AVAILABLE":"NOT_APPLICABLE"});
        const report_token=id();
        const asOf = at(date_to,"20:00");
        reports.set(report_token,{items,asOf,details:operatingDetails});
        if(reports.size>100) reports.delete(reports.keys().next().value!);
        return {date_from,date_to,as_of:asOf,report_token,scope:{clinic_ids:selectedClinics,dentist_ids},
          appointments:{...fact,denominator:items.length,attendance_rate:rate(fact.attended,items.length),
            cancellation_rate:rate(fact.patient_cancelled,items.length),
            by_clinic:selectedClinics.map(clinic_id=>({clinic_id,...counts(items.filter(row=>row.clinic_id===clinic_id))}))},
          clinical:{actual_starts:fact.attended,normal_completions:completed,actual_treatments:completed},
          financial:{net_received:(sum("received")-sum("refunded")).toFixed(2),accrued:sum("accrued").toFixed(2),
            received:sum("received").toFixed(2),refunded:sum("refunded").toFixed(2),outstanding:sum("outstanding").toFixed(2)},
          standard_coverage:rate(completed,completed),skills:qualifications.map(q=>({code:q.qualification_id,name:q.qualification_name,dentists:people().filter(person=>person.qualifications.some(item=>item.qualification_id===q.qualification_id)).length})),
          performance:periods.flatMap(p=>{
            const row=confirmed(revisions.get(p.period_id)??[]);
            return row ? [{...p,revision_no:row.revision_no,company:row.company}] : [];
          }),
          ...operatingReport,
          sources:{appointments:"合成统计",clinical:"合成接诊",coverage:"合成计费项目",
            financial:"合成已确认收退",skills:"合成资质",performance:"合成确认版",
            ...operatingReport.sources},
        };
      }
      if(route==="/reports/operations/details"){
        need("HQ_OPERATIONS_QUERY");
        const report=reports.get(q.get("report_token")??"");
        if(!report) problem(404,"请重新查询经营报表。");
        const metric=q.get("metric")??"";
        if (report.details?.[metric]) {
          const rows = report.details[metric].filter(row => wanted(q.get("clinic_id"), String(row.clinic_id ?? ""))
            && capability("HQ_OPERATIONS_QUERY", String(row.clinic_id ?? "")));
          const cursor=Number(q.get("cursor")??"0");
          return {items:rows.slice(cursor,cursor+20),total:rows.length,as_of:report.asOf,
            next_cursor:cursor+20<rows.length?String(cursor+20):null};
        }
        const state:Record<string,string[]> = {unprocessed:["CONFIRMED","CHECKED_IN"], no_show:["NO_SHOW"],
          patient_cancelled:["CANCELLED"], clinic_cancelled:[], attended:["COMPLETED","IN_TREATMENT"],
          actual_starts:["COMPLETED","IN_TREATMENT"], normal_completions:["COMPLETED"], actual_treatments:["COMPLETED"],
          coverage:["COMPLETED"]};
        const items=report.items.filter(row=>wanted(q.get("clinic_id"),row.clinic_id) && capability("HQ_OPERATIONS_QUERY",row.clinic_id))
          .flatMap(row=>{
            const {received,refunded,accrued,outstanding,...base}=row;
            const amounts:Record<string,number | undefined>={received,refunded,accrued,outstanding,
              net_received:(received??0)-(refunded??0)};
            if (Object.hasOwn(amounts,metric)) return amounts[metric] ? [{...base,amount:amounts[metric]!.toFixed(2)}] : [];
            return !state[metric] || state[metric].includes(row.status) ? [base] : [];
          });
        const cursor=Number(q.get("cursor")??"0");
        return {items:items.slice(cursor,cursor+20),total:items.length,as_of:report.asOf,
          next_cursor:cursor+20<items.length?String(cursor+20):null};
      }
      problem(404,"此样例没有相应记录。");
    }
    return async function request<T>(path:string, details:{method?:"GET"|"POST"|"PATCH";body?:unknown;actionKey?:string;signal?:AbortSignal;queueSearch?:string}={}):Promise<T>{
      details.signal?.throwIfAborted();
      const [route,search] = path.split("?");
      const body = (details.body ?? {}) as Body;
      const finance = billing.dispatch(route,new URLSearchParams(search),details.method ?? "GET",body,details.actionKey,identity(role));
      if (finance !== undefined) return structuredClone(finance) as T;
      const signature=JSON.stringify([path,details.method,details.body]);
      if(path.startsWith("/holds/by-action?") || route.endsWith("/analysis/by-action"))
        return structuredClone(dispatch(path,"GET",{},details)) as T;
      const prior=details.actionKey ? processed.get(details.actionKey):undefined;
      if(prior&&prior.signature!==signature) problem(409,"该操作结果已登记，请查询原操作。");
      if(prior) return structuredClone(prior.result) as T;
      const result=structuredClone(dispatch(path,details.method??"GET",(details.body??{}) as Body,details));
      if(details.actionKey) processed.set(details.actionKey,{signature,result});
      return result as T;
    };
  }
  return {identity,transport, getAppointment:(id:string) => previewAppointments.find(row=>row.id===id)};
}
