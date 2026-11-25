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
  HQ_PERFORMANCE_CALCULATE: "绩效核算", HQ_PERFORMANCE_REVIEW: "绩效复核", HQ_PERFORMANCE_CONFIRM: "绩效确认" };
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
  {path: "/catalog", label: "项目与价格", icon: "catalog", roles: ["HQ_CATALOG"]},
  {path: "/operations", label: "经营", icon: "chart", roles: ["CLINIC_MANAGER", ...performanceRoles]},
];
export function allowedSections(identity: StaffIdentity, clinic = "") {
  return navigation.filter(section => !section.roles || hasRole(identity, section.roles, clinic));
}
