export const groups = [
  {id:"desk", name:"门诊运营", icon:"calendar", tabs:[
    {id:"desk/home", label:"预约趋势", title:"预约趋势"},
    {id:"desk/calendar", label:"预约日历", title:"预约日历"},
    {id:"desk/staff", label:"跨店排班", title:"跨店排班"},
    {id:"desk/chairs", label:"牙椅资源", title:"牙椅资源"},
  ]},
  {id:"patients", name:"患者与诊疗", icon:"tooth", tabs:[
    {id:"patients/directory", label:"患者档案", title:"患者档案"},
    {id:"patients/queue", label:"接诊队列", title:"接诊队列"},
    {id:"patients/records", label:"诊疗记录", title:"诊疗记录"},
  ]},
  {id:"billing", name:"收费与日结", icon:"receipt", tabs:[
    {id:"billing/queue", label:"结算队列", title:"结算队列"},
    {id:"billing/invoices", label:"账单与收退", title:"账单与收退"},
    {id:"billing/reconcile", label:"日结对账", title:"日结对账"},
    {id:"billing/approvals", label:"更正与审批", title:"更正与审批"},
  ]},
  {id:"operations", name:"经营与配置", icon:"chart", tabs:[
    {id:"operations/overview", label:"经营概览", title:"经营概览"},
    {id:"operations/compare", label:"门店对比", title:"门店对比"},
    {id:"operations/ai", label:"AI 分析", title:"AI 分析"},
    {id:"operations/quarter", label:"季度核算", title:"季度核算"},
    {id:"operations/catalog", label:"项目与价格", title:"项目与价格"},
    {id:"operations/access", label:"门店与授权", title:"门店与授权"},
  ]},
] as const;

export type Tab = (typeof groups)[number]["tabs"][number];
export type Route = Tab["id"] | "home";

export function routeFromHash(): Route {
  const hash = window.location.hash.slice(1).split("?")[0];
  if (hash === "schedule") return "desk/calendar";
  for (const group of groups) {
    if (group.id === hash) return group.tabs[0].id;
    const exact = group.tabs.find(tab => tab.id === hash);
    if (exact) return exact.id;
  }
  return "home";
}
