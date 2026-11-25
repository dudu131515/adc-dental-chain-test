export type FundsStatus = { refund_id: string; amount: string; status: string };
export type Appointment = {
  appointment_id: string; appointment_no: string; claim_id: string; status: string; is_attended: boolean;
  clinic: { clinic_id: string; name: string; address: string };
  dentist: { dentist_id: string; name: string };
  treatment: { treatment_type_id: string; name: string };
  start_at: string; end_at: string; change_deadline_at?: string; calendar_issue?: string;
  patient_display?: { patient_id: string; name: string };
  deposit?: { deposit_id: string; amount: string; status: string };
  refund?: FundsStatus;
  chair?: Chair | null;
  visit_id?: string | null;
  allowed_actions: string[];
};

export type Chair = { chair_id: string; chair_no: string; chair_kind?: string };
export type Candidate = { clinic_id: string; dentist_id: string; dentist_name: string; shift_id: string;
  treatment_type_id: string; start_at: string; end_at: string; };

export const appointmentStates: Record<string, string> = {
  CONFIRMED: "已确认", CHECKED_IN: "已签到", IN_TREATMENT: "诊疗中", COMPLETED: "履约结束",
  CANCELLED: "已取消", NO_SHOW: "已核实爽约",
};
export const fundingStates: Record<string, string> = {
  PAID: "已付款", SUCCEEDED: "已成功", PENDING: "处理中", FAILED: "失败", RETAINED: "已保留", NOT_STARTED: "待付款",
};
