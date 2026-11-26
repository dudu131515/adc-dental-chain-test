export const clinics = {central: "中心口腔门诊", river: "滨江口腔门诊"} as const;
export type Clinic = keyof typeof clinics;
export const days = ["2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"] as const;
export const statusLabels = {
  booked: "已确认", arrived: "已签到", treating: "诊疗中",
  done: "已结束", missed: "已核实爽约", cancelled: "已取消",
} as const;
export type Status = keyof typeof statusLabels;
export type Appointment = {
  id: string; date: string; clinic: Clinic; time: string; patient: string; patientId: string; minutes?: number;
  service: string; doctor: string; status: Status; allergy?: string; invoice?: string;
};
const today = days[0];
const tomorrow = days[1];
export const appointments: Appointment[] = [
  {id:"ADC-DEMO-001", date:today, clinic:"central", time:"08:30", patient:"赵青", patientId:"3", service:"口腔检查", doctor:"林明远", status:"done"},
  {id:"ADC-DEMO-002", date:today, clinic:"central", time:"09:00", patient:"陈晓雨", patientId:"1", service:"洁牙护理", doctor:"林明远", status:"done", allergy:"乳胶", invoice:"ADC-DEMO-INV-120"},
  {id:"ADC-DEMO-003", date:today, clinic:"central", time:"09:30", patient:"罗珊", patientId:"5", service:"树脂充填", doctor:"林明远", status:"missed"},
  {id:"ADC-DEMO-004", date:today, clinic:"central", time:"10:30", patient:"宋晨", patientId:"6", service:"洁牙护理", doctor:"林明远", status:"cancelled"},
  {id:"ADC-DEMO-005", date:today, clinic:"central", time:"11:00", patient:"孟子安", patientId:"2", service:"口腔检查", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-006", date:today, clinic:"central", time:"13:30", patient:"王安琪", patientId:"7", service:"树脂充填", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-007", date:today, clinic:"central", time:"14:00", patient:"吴天", patientId:"8", service:"洁牙护理", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-008", date:today, clinic:"central", time:"14:30", patient:"程歌", patientId:"9", service:"口腔检查", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-009", date:today, clinic:"central", time:"15:00", patient:"李嘉", patientId:"10", service:"口腔检查", doctor:"周宁", status:"treating"},
  {id:"ADC-DEMO-010", date:today, clinic:"central", time:"16:00", patient:"许言", patientId:"4", service:"树脂充填", doctor:"林明远", status:"arrived", allergy:"青霉素"},
  {id:"ADC-DEMO-021", date:today, clinic:"river", time:"09:00", patient:"顾晓宁", patientId:"11", service:"洁牙护理", doctor:"何可", status:"done", invoice:"ADC-DEMO-INV-131"},
  {id:"ADC-DEMO-022", date:today, clinic:"river", time:"10:00", patient:"梁菲", patientId:"12", service:"口腔检查", doctor:"何可", status:"done"},
  {id:"ADC-DEMO-023", date:today, clinic:"river", time:"14:00", patient:"沈淮", patientId:"13", service:"树脂充填", doctor:"顾然", status:"arrived"},
  {id:"ADC-DEMO-024", date:today, clinic:"river", time:"15:30", patient:"许晓秋", patientId:"14", service:"口腔检查", doctor:"顾然", status:"booked"},
  {id:"ADC-DEMO-011", date:tomorrow, clinic:"central", time:"10:30", patient:"陈晓雨", patientId:"1", service:"口腔检查", doctor:"林明远", status:"booked", allergy:"乳胶"},
  {id:"ADC-DEMO-025", date:tomorrow, clinic:"river", time:"15:00", patient:"沈淮", patientId:"13", service:"洁牙护理", doctor:"顾然", status:"booked"},
].sort((a,b) => a.time.localeCompare(b.time)) as Appointment[];
const samplePatients=["梁语","俞静","龚婷","夏言","郭帆","杜思彤","罗杏","苏怡","柳明","欧阳欣","于航","韩茵"];
const sampleDoctors={central:["林明远","周宁"],river:["何可","顾然"]};
const sampleServices=["口腔检查","树脂充填","洁牙护理","根管治疗","牙周基础治疗"];
const sampleStatuses:Status[]=["done","arrived","treating","booked","missed","cancelled"];
for(const [dayIndex,date] of days.slice(2).entries()){
  for(const [i,patient] of samplePatients.entries()){
    const clinic=i%2===0?"central":"river";
    const status=sampleStatuses[(i+dayIndex)%sampleStatuses.length];
    const number=100+dayIndex*20+i;
    appointments.push({id:"ADC-DEMO-"+number,date,clinic,patient,patientId:String(15+i),doctor:sampleDoctors[clinic][(i+dayIndex)%2],
      time:String(8+Math.floor(i/2)).padStart(2,"0")+":"+(i%2?"30":"00"),
      service:sampleServices[i%sampleServices.length],status,
      allergy:i%5===0?"乳胶":i%7===0?"青霉素":undefined,
      invoice:status==="done"?"ADC-DEMO-INV-"+number:undefined});
  }
}

export const invoices:Record<string,{status:string;due:number;received:number;refunded:number;outstanding:number;pendingRefund?:number}> = {
  "ADC-DEMO-INV-120": {status:"部分收款", due:180, received:80, refunded:0, outstanding:100},
  "ADC-DEMO-INV-131": {status:"已结清", due:150, received:180, refunded:20, outstanding:0},
};
for(const [index,row] of appointments.filter(item=>item.invoice&&!invoices[item.invoice]).entries()){
  const due=180+index*50;
  const received=index===0?0:index===1?due+60:index%2===0?due:80;
  invoices[row.invoice!]={status:index===1?"退款处理中":received===0?"待收款":received===due?"已结清":"部分收款",
    due,received,refunded:0,outstanding:Math.max(0,due-received),pendingRefund:index===1?30:undefined};
}

type Fund = {clinic: Clinic; date: string; id: string; label: string; type: "deposit" | "treatment"; kind: "received" | "refund" | "pending"; value: number; time: string};
export const funds: Fund[] = [
  {clinic:"central",date:today,id:"ADC-DEMO-001",label:"预约金实收",type:"deposit",kind:"received",value:50,time:"08:10"},
  {clinic:"central",date:today,id:"ADC-DEMO-002",label:"预约金已退",type:"deposit",kind:"refund",value:50,time:"09:03"},
  {clinic:"central",date:today,id:"ADC-DEMO-INV-120",label:"诊疗收款",type:"treatment",kind:"received",value:80,time:"09:32"},
  {clinic:"central",date:today,id:"ADC-DEMO-INV-120",label:"诊疗收款在途",type:"treatment",kind:"pending",value:30,time:"09:36"},
  {clinic:"river",date:today,id:"ADC-DEMO-021",label:"预约金实收",type:"deposit",kind:"received",value:50,time:"08:20"},
  {clinic:"river",date:today,id:"ADC-DEMO-INV-131",label:"诊疗收款",type:"treatment",kind:"received",value:180,time:"10:14"},
  {clinic:"river",date:today,id:"ADC-DEMO-INV-131",label:"诊疗已退",type:"treatment",kind:"refund",value:20,time:"14:42"},
];


export const chairs = [
  {code:"A-01",clinic:"central",doctor:"林明远",room:"第一诊室",type:"通用"},
  {code:"A-02",clinic:"central",doctor:"周宁",room:"第二诊室",type:"通用"},
  {code:"A-03",clinic:"central",doctor:"",room:"第三诊室",type:"通用"},
  {code:"B-01",clinic:"river",doctor:"何可",room:"第一诊室",type:"通用"},
  {code:"B-02",clinic:"river",doctor:"顾然",room:"第二诊室",type:"通用"},
] as const;

for(const row of appointments.filter(item=>item.invoice&&item.date>days[1])){
  const invoice=invoices[row.invoice!];
  funds.push({clinic:row.clinic,date:row.date,id:row.invoice!,label:"诊疗收款",type:"treatment",kind:"received",value:invoice.received,time:row.time});
  funds.push({clinic:row.clinic,date:row.date,id:row.id,label:"预约金已退",type:"deposit",kind:"refund",value:50,time:row.time});
}

export const staffShifts = [
  {doctor:"林明远",clinic:"central",date:today,time:"08:30–17:00",status:"已发布"},
  {doctor:"周宁",clinic:"central",date:today,time:"09:00–17:30",status:"已发布"},
  {doctor:"何可",clinic:"river",date:today,time:"08:30–16:30",status:"已发布"},
  {doctor:"顾然",clinic:"river",date:today,time:"10:00–17:30",status:"已发布"},
  {doctor:"林明远",clinic:"central",date:tomorrow,time:"08:30–12:00",status:"已发布"},
  {doctor:"林明远",clinic:"river",date:tomorrow,time:"14:00–17:30",status:"已发布"},
  {doctor:"顾然",clinic:"river",date:tomorrow,time:"09:00–17:00",status:"待回应"},
] as const;

export const catalog = [
  {code:"EXAM",name:"口腔检查",price:80,duration:30,date:"2026-09-01"},
  {code:"CLEAN",name:"洁牙护理",price:180,duration:30,date:"2026-09-01"},
  {code:"FILL",name:"树脂充填",price:280,duration:30,date:"2026-09-01"},
] as const;
export const approvals = [
  {id:"COR-DEMO-031",appointment:"ADC-DEMO-021",clinic:"river",reason:"计费项目差额",amount:-30,status:"已入账"},
  {id:"COR-DEMO-032",appointment:"ADC-DEMO-001",clinic:"central",reason:"治疗记录更正",amount:0,status:"待主管复核"},
  {id:"COR-DEMO-036",appointment:"ADC-DEMO-024",clinic:"river",reason:"重复挂号结果核查",amount:0,status:"已退回"},
  {id:"COR-DEMO-041",appointment:"ADC-DEMO-010",clinic:"central",reason:"更正牙位记录",amount:0,status:"待主管复核"},
  {id:"COR-DEMO-045",appointment:"ADC-DEMO-021",clinic:"river",reason:"旧明细误用标准价",amount:-20,status:"已入账"},
  {id:"COR-DEMO-046",appointment:"ADC-DEMO-002",clinic:"central",reason:"补充已实施项目证据",amount:40,status:"待主管复核"},
] as const;

type Daily = {day:string; clinic:Clinic; arrived:number; total:number; unresolved:number; net:number};
const reportDays = ["11-17","11-18","11-19","11-24","11-25","11-26"];
const storeDaily = {
  central:[[2,3,0,100],[2,2,0,0],[2,3,1,60],[1,3,1,0],[2,3,1,80],[1,2,1,0]],
  river:[[0,1,1,30],[1,2,1,0],[1,1,0,90],[1,1,0,0],[2,2,0,160],[0,1,1,0]],
} satisfies Record<Clinic, number[][]>;
export const offices = Object.keys(clinics) as Clinic[];
export const dailyFacts:Daily[] = offices.flatMap(clinic => storeDaily[clinic].map(
  ([arrived,total,unresolved,net],index) => ({clinic,day:reportDays[index],arrived,total,unresolved,net}),
));
export function sumFacts(rows:Daily[]) {
  return rows.reduce((sum,row) => ({
    arrived:sum.arrived+row.arrived,total:sum.total+row.total,unresolved:sum.unresolved+row.unresolved,net:sum.net+row.net,
  }),{arrived:0,total:0,unresolved:0,net:0});
}
export const comparison = Object.fromEntries(offices.map(clinic => {
  const rows=dailyFacts.filter(row => row.clinic === clinic);
  return [clinic,{previous:sumFacts(rows.slice(0,3)),current:sumFacts(rows.slice(3))}];
})) as Record<Clinic,Record<"previous" | "current",ReturnType<typeof sumFacts>>>;
export const period = {previous:"11 月 17–19 日", current:"11 月 24–26 日"} as const;

export function money(value: number) {
  return new Intl.NumberFormat("zh-CN", {style:"currency", currency:"CNY", minimumFractionDigits:2}).format(value);
}
