import { ApiError } from "../src/shared/api";
import { jobLabels, type JobCode } from "../src/shared/navigation";

export type SampleBranch = {
  clinic_id: string; clinic_no: string; name: string; address: string;
  phone: string | null; email: string | null; status: string;
};
export type SampleEmployee = {
  employee_id: string; employee_no: string; full_name: string; job_code: JobCode; home_clinic_id: string | null;
  employee_status: string; account_status: string | null; can_manage_grants: boolean; can_manage_account: boolean;
  grants: {role_code: string; clinic_id: string}[];
};
export type SampleResource = {
  chair_id: string; clinic_id: string; chair_no: string; chair_kind: string; status: string;
  unavailability: {unavailability_id: string; start_at: string; end_at: string; reason: string}[];
};
export type SampleQualification = {qualification_id: string; qualification_code: string; qualification_name: string};
type Credential = {
  credential_id: string; employee_id: string; qualification_id: string;
  certificate_no: string | null; valid_from: string | null; valid_until: string | null;
};
type Material = {material_id: string; material_code: string; material_name: string; standard_unit: string; status: string};
type Cost = {cost_id: string; material_id: string; unit_cost: string; effective_from: string; effective_to: string | null};
export type SampleMaterial = {material_id: string; material_name: string; standard_unit: string; reference: string; cost: string};
export const sampleMaterials: SampleMaterial[] = [
  {material_id:"1",material_name:"一次性口腔检查包",standard_unit:"套",reference:"ADC-DEMO-COST-001",cost:"8.00"},
  {material_id:"2",material_name:"洁牙工作尖",standard_unit:"支",reference:"ADC-DEMO-COST-002",cost:"15.00"},
  {material_id:"3",material_name:"复合树脂",standard_unit:"份",reference:"ADC-DEMO-COST-003",cost:"22.00"},
];
type Body = Record<string,unknown>;
type Seed = {
  branches: SampleBranch[]; employees: SampleEmployee[]; resources: SampleResource[]; qualifications: SampleQualification[];
  credentials: Credential[]; id: () => string; day: string;
  verifyChairChange: (previous:SampleResource,next:SampleResource) => void;
};
type Actor = { admin: boolean; catalog: boolean };

function fail(status: number, message: string): never {
  throw new ApiError(status,{code:status===403?"PERMISSION_DENIED":status===404?"NOT_FOUND":status===409?"CONFLICT":"VALIDATION_ERROR",message});
}
function required(value: unknown, label: string) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) fail(400,"请填写" + label + "。");
  return result;
}
function optional(value:unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function status(value:unknown, allowed:string[]) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(400,"请选择有效状态。");
  return value;
}
function date(value:unknown, label:string) {
  const text = required(value,label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text))
    || new Date(text).toISOString().slice(0,10) !== text) fail(400,"请选择有效日期。");
  return text;
}
function record<T>(rows:T[], find:(row:T)=>boolean, message:string) {
  const item = rows.find(find);
  if (!item) fail(404,message);
  return item;
}
function save<T>(rows:T[], existing:T|undefined, item:T) {
  if (existing) Object.assign(existing,item);
  else rows.push(item);
  return item;
}

export function createSampleMasterData({branches,employees,resources,qualifications,credentials,id,day,verifyChairChange}:Seed) {
  const materials: Material[] = sampleMaterials.map(row => ({
    material_id:row.material_id,material_code:"ADC-M"+row.material_id,material_name:row.material_name,
    standard_unit:row.standard_unit,status:"ACTIVE",
  }));
  const costs: Cost[] = sampleMaterials.map(row => ({cost_id:row.reference,material_id:row.material_id,
    unit_cost:row.cost,effective_from:"2025-01-01",effective_to:null}));
  const accounts = new Set<string>();
  const branch = (clinicId:string) => record(branches,row=>row.clinic_id===clinicId,"找不到门店。");
  const currentCost = (materialId:string,on:string) => costs.find(row => row.material_id===materialId && row.effective_from<=on
    && (!row.effective_to || row.effective_to>on));
  function qualificationsFor(employeeId:string) {
    return credentials.filter(row=>row.employee_id===employeeId).flatMap(row=>{
      const license=qualifications.find(item=>item.qualification_id===row.qualification_id);
      return license ? [{qualification_id:license.qualification_id,name:license.qualification_name,
        valid_from:row.valid_from, valid_until:row.valid_until}] : [];
    });
  }
  function materialsFor(on:string):SampleMaterial[] {
    return materials.filter(row=>row.status==="ACTIVE").flatMap(row=>{
      const cost=currentCost(row.material_id,on);
      return cost ? [{material_id:row.material_id,material_name:row.material_name,standard_unit:row.standard_unit,
        cost:cost.unit_cost,reference:cost.cost_id}] : [];
    });
  }

  function staffAccount(body:Body) {
    const login=required(body.login_identity,"登录账号");
    const password=required(body.password,"初始密码");
    if (password.length<12 || /^\d+$/.test(password) || /^(password|qwerty|adc-preview)/i.test(password))
      fail(400,"请使用至少 12 个字符且不常见的初始密码。");
    if (accounts.has(login)) fail(409,"该登录账号已存在。");
    accounts.add(login);
  }

  function dispatch(route:string,method:string,body:Body,actor:Actor):unknown {
    const read=method==="GET";
    const employeeRoute=route.match(/^\/admin\/access\/employees(?:\/([^/]+)\/account)?$/);
    if (employeeRoute && method==="POST") {
      if (!actor.admin) fail(403,"当前样例身份无权维护员工。");
      if (employeeRoute[1]) {
        const employee=record(employees,row=>row.employee_id===employeeRoute[1],"找不到员工。");
        if (employee.account_status) fail(409,"该员工已有登录账号。");
        staffAccount(body);
        employee.account_status="ACTIVE";
        employee.can_manage_account=true;
        return {employee_id:employee.employee_id,account_status:employee.account_status};
      }
      const employee_no=required(body.employee_no,"工号");
      const full_name=required(body.full_name,"姓名");
      const job=required(body.job_code,"所属岗位") as JobCode;
      const home=optional(body.home_clinic_id);
      if (!Object.hasOwn(jobLabels,job) || (job==="HEADQUARTERS" ? home!==null : !home)) fail(400,"请核对岗位和所属门店。");
      if (home) branch(home);
      if (employees.some(row=>row.employee_no===employee_no)) fail(409,"工号已存在。");
      const account=body.account;
      if (account && typeof account==="object") staffAccount(account as Body);
      const employee: SampleEmployee={employee_id:id(),employee_no,full_name,job_code:job,home_clinic_id:home,
        employee_status:"ACTIVE",account_status:account?"ACTIVE":null,can_manage_account:Boolean(account),
        can_manage_grants:true,grants:[]};
      employees.push(employee);
      return employee;
    }
    const routeParts=route.match(/^\/admin\/(clinics|qualifications|dentist-qualifications|chairs|materials)(?:\/([^/]+))?(\/costs)?$/);
    if (!routeParts) return undefined;
    const [,area,target,isCosts]=routeParts;
    if (!(actor.admin || (actor.catalog && area!=="clinics"))) fail(403,"当前样例身份无权维护该资料。");
    if (area==="clinics") {
      if (read) return {items:branches};
      const prior=target ? branch(target) : undefined;
      const draft={...prior,...body};
      const clinic_no=required(draft.clinic_no,"门店编号");
      if (branches.some(row=>row!==prior && row.clinic_no===clinic_no)) fail(409,"门店编号已存在。");
      return save(branches,prior,{clinic_id:prior?.clinic_id??id(),clinic_no,name:required(draft.name,"门店名称"),
        address:required(draft.address,"地址"),phone:optional(draft.phone),email:optional(draft.email),
        status:status(draft.status,["ACTIVE","INACTIVE"])});
    }
    if (area==="qualifications") {
      if (read) return {items:qualifications};
      const prior=target ? record(qualifications,row=>row.qualification_id===target,"找不到资质。") : undefined;
      const draft={...prior,...body};
      const qualification_code=required(draft.qualification_code,"资质编码");
      if (qualifications.some(row=>row!==prior && row.qualification_code===qualification_code)) fail(409,"资质编码已存在。");
      return save(qualifications,prior,{qualification_id:prior?.qualification_id??id(),qualification_code,
        qualification_name:required(draft.qualification_name,"资质名称")});
    }
    if (area==="dentist-qualifications") {
      const dentists=employees.filter(row=>row.job_code==="DENTIST" || row.grants.some(grant=>grant.role_code==="DENTIST"))
        .map(({employee_id,employee_no,full_name})=>({employee_id,employee_no,full_name}));
      function view(row:Credential) {
        const qualification=qualifications.find(item=>item.qualification_id===row.qualification_id);
        const employee=employees.find(item=>item.employee_id===row.employee_id);
        return {...row,employee_no:employee?.employee_no,employee_name:employee?.full_name,
          qualification_code:qualification?.qualification_code,qualification_name:qualification?.qualification_name};
      }
      if (read) return {items:credentials.map(view),dentists,qualifications};
      const prior=target ? record(credentials,row=>row.credential_id===target,"找不到牙医资质。") : undefined;
      const draft={...prior,...body};
      const employee_id=required(draft.employee_id,"牙医");
      const qualification_id=required(draft.qualification_id,"资质");
      if (prior && (prior.employee_id!==employee_id || prior.qualification_id!==qualification_id)) fail(409,"原牙医和资质归属需保留。");
      if (!prior) record(dentists,row=>row.employee_id===employee_id,"找不到牙医。");
      record(qualifications,row=>row.qualification_id===qualification_id,"找不到资质。");
      const valid_from=draft.valid_from ? date(draft.valid_from,"生效日期") : null;
      const valid_until=draft.valid_until ? date(draft.valid_until,"有效期至") : null;
      if (valid_from && valid_until && valid_until<valid_from) fail(400,"有效期不能早于生效日期。");
      if (credentials.some(row=>row!==prior && row.employee_id===employee_id && row.qualification_id===qualification_id
        && (row.valid_until===null || valid_from===null || valid_from<=row.valid_until)
        && (valid_until===null || row.valid_from===null || row.valid_from<=valid_until))) fail(409,"资质有效期重叠。");
      return view(save(credentials,prior,{credential_id:prior?.credential_id??id(),employee_id,qualification_id,
        certificate_no:optional(draft.certificate_no),valid_from,valid_until}));
    }
    if (area==="chairs") {
      const view=(row:SampleResource)=>({...row,clinic_name:branch(row.clinic_id).name});
      if (read) return {items:resources.map(view),clinics:branches};
      const prior=target ? record(resources,row=>row.chair_id===target,"找不到牙椅。") : undefined;
      const draft={...prior,...body};
      const clinic_id=required(draft.clinic_id,"所属门店");
      branch(clinic_id);
      const chair_no=required(draft.chair_no,"牙椅编号");
      if (resources.some(row=>row!==prior && row.clinic_id===clinic_id && row.chair_no===chair_no)) fail(409,"门店内牙椅编号已存在。");
      const next={chair_id:prior?.chair_id??id(),clinic_id,chair_no,chair_kind:required(draft.chair_kind,"牙椅类型"),
        status:status(draft.status,["AVAILABLE","INACTIVE"]),unavailability:prior?.unavailability??[]};
      if (prior) verifyChairChange(prior,next);
      return view(save(resources,prior,next));
    }
    const material=target ? record(materials,row=>row.material_id===target,"找不到耗材。") : undefined;
    if (material && isCosts) {
      const history=costs.filter(row=>row.material_id===material.material_id);
      if (read) return {items:history.sort((a,b)=>b.effective_from.localeCompare(a.effective_from))};
      const effective_from=date(body.effective_from,"生效日期");
      const effective_to=body.effective_to ? date(body.effective_to,"终止日期") : null;
      const amount=required(body.unit_cost,"单位成本");
      if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(amount) || (effective_to && effective_to<=effective_from)) fail(400,"请核对成本和生效区间。");
      const replaced=body.replace_cost_id
        ? record(history,row=>row.cost_id===body.replace_cost_id,"找不到需要结束的成本版本。") : undefined;
      if (replaced && (body.replace_effective_to!==effective_from || replaced.effective_from>=effective_from
          || (replaced.effective_to && replaced.effective_to<=effective_from))) fail(400,"结束原版本时须使用新版本的生效日期。");
      if (history.some(row=>row!==replaced && (!row.effective_to || row.effective_to>effective_from)
        && (!effective_to || row.effective_from<effective_to))) fail(409,"成本版本的有效日期重叠。");
      if (replaced) replaced.effective_to=effective_from;
      const next={cost_id:id(),material_id:material.material_id,unit_cost:Number(amount).toFixed(2),effective_from,effective_to};
      costs.push(next);
      return next;
    }
    const view=(row:Material)=>({...row,current_unit_cost:currentCost(row.material_id,day)?.unit_cost??null});
    if (read) return {items:materials.map(view)};
    const draft={...material,...body};
    const material_code=required(draft.material_code,"耗材编码");
    if (materials.some(row=>row!==material && row.material_code===material_code)) fail(409,"耗材编码已存在。");
    return view(save(materials,material,{material_id:material?.material_id??id(),material_code,
      material_name:required(draft.material_name,"耗材名称"),standard_unit:required(draft.standard_unit,"单位"),
      status:status(draft.status,["ACTIVE","INACTIVE"])}));
  }
  return {dispatch,qualificationsFor,materialsFor};
}
