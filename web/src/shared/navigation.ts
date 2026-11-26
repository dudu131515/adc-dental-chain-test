import type { IconName } from "./Icons";

export type StaffIdentity = {
  account_id: string; category: "staff"; employee_id: string; capabilities: string[];
  clinics: { clinic_id: string; name: string }[]; role_clinic_ids?: Record<string, string[] | null>;
};
export function canWorkAt(identity: StaffIdentity, role: string, clinic: string) {
  if (!identity.capabilities.includes(role)) return false;
  const scope = identity.role_clinic_ids?.[role];
  return scope == null || scope.includes(clinic);
}
export const dailyRoles = ["FRONT_DESK", "DENTIST", "CLINIC_MANAGER", "HQ_SCHEDULER"];
export const performanceRoles = ["HQ_OPERATIONS_QUERY", "HQ_PERFORMANCE_CALCULATE", "HQ_PERFORMANCE_REVIEW", "HQ_PERFORMANCE_CONFIRM"];
export const roleNames: Record<string, string> = { FRONT_DESK: "诊所前台", DENTIST: "责任牙医", CLINIC_MANAGER: "诊所主管",
  HQ_SCHEDULER: "总部排班", HQ_CATALOG: "项目管理", HQ_OPERATIONS_QUERY: "经营查询",
  HQ_PERFORMANCE_CALCULATE: "绩效核算", HQ_PERFORMANCE_REVIEW: "绩效复核", HQ_PERFORMANCE_CONFIRM: "绩效确认", HQ_ACCESS_ADMIN: "总部权限管理" };

const jobRoles = [
  { label: "总部管理人员", permissions: ["HQ_SCHEDULER", "HQ_CATALOG", ...performanceRoles] },
  { label: "诊所主管", permissions: ["CLINIC_MANAGER"] },
  { label: "前台", permissions: ["FRONT_DESK"] },
  { label: "牙医", permissions: ["DENTIST"] },
];

export function inferredJob(capabilities: string[]) {
  const jobs = jobRoles.filter(job => job.permissions.some(role => capabilities.includes(role)));
  return jobs.length === 1 ? jobs[0].label : jobs.length ? "岗位待核对" : "员工";
}

export function hasAccessAdministration(identity: StaffIdentity) {
  return identity.capabilities.includes("HQ_ACCESS_ADMIN") && identity.role_clinic_ids?.HQ_ACCESS_ADMIN === null;
}

export function hasRole(identity: StaffIdentity, roles: string[], clinic: string) {
  return roles.some(role => clinic ? canWorkAt(identity, role, clinic) : identity.capabilities.includes(role));
}
type Section = {path: string; label: string; icon: IconName; roles?: string[]};
export const navigation: Section[] = [
  {path: "/dashboard", label: "首页", icon: "dashboard"},
  {path: "/schedule", label: "排班与预约", icon: "calendar", roles: dailyRoles},
  {path: "/patients", label: "患者档案", icon: "patients", roles: ["FRONT_DESK"]},
  {path: "/clinical", label: "诊疗", icon: "tooth", roles: ["DENTIST"]},
  {path: "/billing", label: "结算", icon: "receipt", roles: ["FRONT_DESK", "DENTIST", "CLINIC_MANAGER"]},
  {path: "/admin", label: "基础管理", icon: "layers", roles: ["HQ_ACCESS_ADMIN"]},
  {path: "/catalog", label: "项目与价格", icon: "catalog", roles: ["HQ_CATALOG"]},
  {path: "/operations", label: "经营", icon: "chart", roles: ["CLINIC_MANAGER", ...performanceRoles]},
];
export function allowedSections(identity: StaffIdentity, clinic = "") {
  return navigation.filter(section => section.path === "/admin"
    ? hasAccessAdministration(identity)
    : (!section.roles || hasRole(identity, section.roles, clinic)));
}

const groups: { id: string; label: string; icon: IconName; paths: string[] }[] = [
  {id: "home", label: "首页", icon: "dashboard", paths: ["/dashboard"]},
  {id: "desk", label: "门诊运营", icon: "calendar", paths: ["/schedule"]},
  {id: "care", label: "患者与诊疗", icon: "patients", paths: ["/patients", "/clinical"]},
  {id: "cashier", label: "收费与日结", icon: "receipt", paths: ["/billing"]},
  {id: "operations", label: "经营与配置", icon: "chart", paths: ["/operations", "/admin", "/catalog"]},
];

export function groupedNavigation(choices: Section[]) {
  return groups.flatMap(group => {
    const sections = group.paths.flatMap(path => choices.filter(section => section.path === path));
    return sections.length ? [{...group, sections}] : [];
  });
}

export function canSeeDailyReconciliation(identity: StaffIdentity, clinic: string) {
  return hasRole(identity, ["FRONT_DESK", "CLINIC_MANAGER"], clinic);
}

type WorkspaceTab = {path: string; label: string};

export function scheduleViews(identity: StaffIdentity, clinic: string) {
  const canPlan = hasRole(identity, ["HQ_SCHEDULER", "CLINIC_MANAGER"], clinic);
  return [
    {id: "appointments", label: "预约日历"},
    ...(canPlan || hasRole(identity, ["DENTIST"], clinic) ? [{id: "shifts", label: "跨店排班"}] : []),
    ...(canPlan ? [{id: "demands", label: "排班需求"}, {id: "resources", label: "牙椅停用"}] : []),
  ];
}

export function workspaceTabs(group: ReturnType<typeof groupedNavigation>[number], identity: StaffIdentity, clinic: string) {
  const canReport = hasRole(identity, ["HQ_OPERATIONS_QUERY"], clinic);
  const canQuarter = hasRole(identity, performanceRoles, clinic);
  const canExpense = canQuarter || hasRole(identity, ["CLINIC_MANAGER"], clinic);
  return group.sections.flatMap<WorkspaceTab>(section => {
    if (section.path === "/schedule") return [
      {path: "/schedule/today", label: "今日门诊"},
      ...scheduleViews(identity, clinic).map(view => ({path: "/schedule?view=" + view.id, label: view.label})),
    ];
    if (section.path === "/clinical") return [
      {path:"/clinical",label:"接诊队列"}, {path:"/clinical/records",label:"诊疗记录"},
    ];
    if (section.path === "/billing") return [
      ...(hasRole(identity, ["FRONT_DESK"], clinic) ? [{path: "/billing", label: "结算队列"}, {path: "/billing/invoices", label: "账单与收退"}] : []),
      ...(canSeeDailyReconciliation(identity, clinic) ? [{path: "/billing/reconciliation", label: "日结对账"}] : []),
      ...(hasRole(identity, ["FRONT_DESK","DENTIST","CLINIC_MANAGER"], clinic) ? [{path: "/billing/corrections", label: "更正与审批"}] : []),
    ];
    if (section.path === "/operations") return [
      ...(canReport ? [{path: "/operations/report", label: "经营报告"}, {path: "/operations/compare", label: "门店对比"}, {path: "/operations/assistant", label: "经营智能助手"}] : []),
      ...(!canReport && canQuarter && !hasRole(identity, ["CLINIC_MANAGER"], clinic)
        ? [{path: "/operations/quarters", label: "季度核算"}, {path: "/operations/expenses", label: "费用登记"}]
        : [
          ...(canExpense ? [{path: "/operations/expenses", label: "费用登记"}] : []),
          ...(canQuarter ? [{path: "/operations/quarters", label: "季度核算"}] : []),
        ]),
    ];
    if (section.path === "/admin") return [
      {path: "/admin/clinics", label: "门店与资源"},
      {path: "/admin/access", label: "人员与授权"},
    ];
    return [{path: section.path, label: section.label}];
  });
}
