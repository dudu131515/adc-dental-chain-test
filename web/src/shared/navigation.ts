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
export function hasRole(identity: StaffIdentity, roles: string[], clinic: string) {
  return roles.some(role => clinic ? canWorkAt(identity, role, clinic) : identity.capabilities.includes(role));
}
type Section = {path: string; label: string; icon: IconName; roles?: string[]};
export const navigation: Section[] = [
  {path: "/dashboard", label: "工作台", icon: "dashboard"},
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
    ? identity.capabilities.includes("HQ_ACCESS_ADMIN")
    : (!section.roles || hasRole(identity, section.roles, clinic)));
}

const groups: { label: string; icon: IconName; paths: string[] }[] = [
  {label: "工作台", icon: "dashboard", paths: ["/dashboard"]},
  {label: "排班与预约", icon: "calendar", paths: ["/schedule"]},
  {label: "患者与诊疗", icon: "patients", paths: ["/patients", "/clinical"]},
  {label: "收费与经营", icon: "receipt", paths: ["/billing", "/operations"]},
  {label: "基础管理", icon: "layers", paths: ["/admin", "/catalog"]},
];

export function groupedNavigation(choices: Section[]) {
  return groups.flatMap(group => {
    const sections = group.paths.flatMap(path => choices.filter(section => section.path === path));
    return sections.length ? [{...group, sections, path: sections[0].path === "/admin" ? "/admin/clinics" : sections[0].path}] : [];
  });
}

export function canSeeDailyReconciliation(identity: StaffIdentity, clinic: string) {
  return hasRole(identity, ["FRONT_DESK", "CLINIC_MANAGER"], clinic);
}

type WorkspaceTab = {path: string; label: string};

export function workspaceTabs(group: ReturnType<typeof groupedNavigation>[number], identity: StaffIdentity, clinic: string) {
  const canReport = hasRole(identity, ["HQ_OPERATIONS_QUERY"], clinic);
  const canQuarter = hasRole(identity, performanceRoles, clinic);
  const canExpense = canQuarter || hasRole(identity, ["CLINIC_MANAGER"], clinic);
  return group.sections.flatMap<WorkspaceTab>(section => {
    if (section.path === "/billing") return [
      {path: "/billing", label: "结算"},
      ...(canSeeDailyReconciliation(identity, clinic) ? [{path: "/billing/reconciliation", label: "日结对账"}] : []),
    ];
    if (section.path === "/operations") return [
      ...(canReport ? [{path: "/operations/report", label: "经营报告"}] : []),
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
