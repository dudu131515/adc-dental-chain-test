export type Rate = {
  numerator: number; denominator: number; value: string | null; availability: string;
};
export type Counts = Record<"attended" | "patient_cancelled" | "no_show" | "unprocessed" | "clinic_cancelled", number>;
export type OperationsSummary = {
  revenue: string; net_received: string; material_cost: string; operating_cost: string; net_profit: string;
  profit_margin: Rate;
  expense_categories: { category: string; amount: string }[];
  expense_periods: { period_id: string; year: number; quarter: number }[];
};
export type TrendPoint = {
  period: string; label: string; revenue: string; material_cost: string; operating_cost: string;
  net_profit: string; appointments: number; attended: number; visits: number; work_minutes: string;
};
export type ClinicMetric = {
  clinic_id: string; clinic_name: string; revenue: string; net_received: string;
  material_cost: string; operating_cost: string; net_profit: string;
  appointments: number; attended: number; no_show: number; patient_cancelled: number; unprocessed: number;
  attendance_rate: Rate; visits: number; treatments: number; work_minutes: string; work_hours: string;
  chair_utilization: Rate; dentist_utilization: Rate;
};
export type WorkloadDentist = {
  clinic_id: string; clinic_name: string; dentist_id: string; dentist_name: string;
  minutes: string; hours: string; visits: number; treatments: number; revenue: string; material_cost: string;
};
export type OperationResources = {
  active_chairs: number; chair_occupied_minutes: string; chair_capacity_minutes: string;
  chair_utilization: Rate; open_chair_days: number; dentist_shift_minutes: string;
  dentist_booked_minutes: string; dentist_work_minutes: string; dentist_utilization: Rate; work_utilization: Rate;
};
export type OfficialVersion = { period_id: string; year: number; quarter: number; revision_no: number; company?: Record<string, string> };
export type Report = {
  date_from: string; date_to: string; as_of: string; report_token: string;
  scope: { clinic_ids: string[]; dentist_ids: string[] };
  appointments: Counts & { denominator: number; attendance_rate: Rate; cancellation_rate: Rate; by_clinic: (Counts & { clinic_id: string })[] };
  clinical: { actual_starts: number; normal_completions: number; actual_treatments: number };
  standard_coverage: Rate;
  financial: Record<"accrued" | "received" | "refunded" | "net_received" | "outstanding", string>;
  skills: { code: string; name: string; dentists: number }[];
  performance: OfficialVersion[];
  sources: Record<string, string>;
  snapshot_refreshed?: boolean; original_as_of?: string;
  operations?: OperationsSummary;
  workload?: { total_minutes: string; total_hours: string; dentists: WorkloadDentist[] };
  resources?: OperationResources;
  clinics?: ClinicMetric[];
  trend?: { granularity: "day" | "month" | string; points: TrendPoint[] };
};
