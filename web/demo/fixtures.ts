export const clinics = {central: "中心口腔门诊", river: "滨江口腔门诊"} as const;
export type Clinic = keyof typeof clinics;
export const days = ["2026-11-25", "2026-11-26"] as const;
export const statusLabels = {
  booked: "已确认", arrived: "已签到", treating: "诊疗中",
  done: "已结束", missed: "已核实爽约", cancelled: "已取消",
} as const;
export type Status = keyof typeof statusLabels;
export type Appointment = {
  id: string; date: (typeof days)[number]; clinic: Clinic; time: string; patient: string;
  service: string; doctor: string; status: Status; allergy?: string; invoice?: string;
};
const today = days[0];
const tomorrow = days[1];
export const appointments: Appointment[] = [
  {id:"ADC-DEMO-001", date:today, clinic:"central", time:"08:30", patient:"赵青", service:"口腔检查", doctor:"林明远", status:"done"},
  {id:"ADC-DEMO-002", date:today, clinic:"central", time:"09:00", patient:"陈晓雨", service:"洁牙护理", doctor:"林明远", status:"done", allergy:"乳胶", invoice:"ADC-DEMO-INV-120"},
  {id:"ADC-DEMO-003", date:today, clinic:"central", time:"09:30", patient:"罗珊", service:"树脂充填", doctor:"林明远", status:"missed"},
  {id:"ADC-DEMO-004", date:today, clinic:"central", time:"10:30", patient:"宋晨", service:"洁牙护理", doctor:"林明远", status:"cancelled"},
  {id:"ADC-DEMO-005", date:today, clinic:"central", time:"11:00", patient:"孟子安", service:"口腔检查", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-006", date:today, clinic:"central", time:"13:30", patient:"王安琪", service:"树脂充填", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-007", date:today, clinic:"central", time:"14:00", patient:"吴天", service:"洁牙护理", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-008", date:today, clinic:"central", time:"14:30", patient:"程歌", service:"口腔检查", doctor:"周宁", status:"booked"},
  {id:"ADC-DEMO-009", date:today, clinic:"central", time:"15:00", patient:"李嘉", service:"口腔检查", doctor:"周宁", status:"treating"},
  {id:"ADC-DEMO-010", date:today, clinic:"central", time:"16:00", patient:"许言", service:"树脂充填", doctor:"林明远", status:"arrived", allergy:"青霉素"},
  {id:"ADC-DEMO-021", date:today, clinic:"river", time:"09:00", patient:"顾晓宁", service:"洁牙护理", doctor:"何可", status:"done", invoice:"ADC-DEMO-INV-131"},
  {id:"ADC-DEMO-022", date:today, clinic:"river", time:"10:00", patient:"梁菲", service:"口腔检查", doctor:"何可", status:"done"},
  {id:"ADC-DEMO-023", date:today, clinic:"river", time:"14:00", patient:"沈淮", service:"树脂充填", doctor:"顾然", status:"arrived"},
  {id:"ADC-DEMO-024", date:today, clinic:"river", time:"15:30", patient:"许晓秋", service:"口腔检查", doctor:"顾然", status:"booked"},
  {id:"ADC-DEMO-011", date:tomorrow, clinic:"central", time:"10:30", patient:"陈晓雨", service:"口腔检查", doctor:"林明远", status:"booked", allergy:"乳胶"},
  {id:"ADC-DEMO-025", date:tomorrow, clinic:"river", time:"15:00", patient:"沈淮", service:"洁牙护理", doctor:"顾然", status:"booked"},
].sort((a,b) => a.time.localeCompare(b.time)) as Appointment[];

export const invoices = {
  "ADC-DEMO-INV-120": {status:"部分收款", due:180, received:80, refunded:0, outstanding:100},
  "ADC-DEMO-INV-131": {status:"已结清", due:150, received:180, refunded:20, outstanding:0},
} as const;

type Fund = {clinic: Clinic; date: (typeof days)[number]; id: string; label: string; type: "deposit" | "treatment"; kind: "received" | "refund" | "pending"; value: number; time: string};
export const funds: Fund[] = [
  {clinic:"central",date:today,id:"ADC-DEMO-001",label:"预约金实收",type:"deposit",kind:"received",value:50,time:"08:10"},
  {clinic:"central",date:today,id:"ADC-DEMO-002",label:"预约金已退",type:"deposit",kind:"refund",value:50,time:"09:03"},
  {clinic:"central",date:today,id:"ADC-DEMO-INV-120",label:"诊疗收款",type:"treatment",kind:"received",value:80,time:"09:32"},
  {clinic:"central",date:today,id:"ADC-DEMO-INV-120",label:"诊疗收款在途",type:"treatment",kind:"pending",value:30,time:"09:36"},
  {clinic:"river",date:today,id:"ADC-DEMO-021",label:"预约金实收",type:"deposit",kind:"received",value:50,time:"08:20"},
  {clinic:"river",date:today,id:"ADC-DEMO-INV-131",label:"诊疗收款",type:"treatment",kind:"received",value:180,time:"10:14"},
  {clinic:"river",date:today,id:"ADC-DEMO-INV-131",label:"诊疗已退",type:"treatment",kind:"refund",value:20,time:"14:42"},
];

export const comparison = {
  central: {previous:{arrived:6,total:8,unresolved:1,net:160}, current:{arrived:4,total:8,unresolved:3,net:80}},
  river: {previous:{arrived:2,total:4,unresolved:2,net:120}, current:{arrived:3,total:4,unresolved:1,net:160}},
} as const;
export const period = {previous:"11 月 17–19 日", current:"11 月 24–26 日"} as const;

export function money(value: number) {
  return new Intl.NumberFormat("zh-CN", {style:"currency", currency:"CNY", minimumFractionDigits:2}).format(value);
}
