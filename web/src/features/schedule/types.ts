export type Shift = {
  shift_id: string;
  clinic_id: string;
  dentist_id: string;
  demand_id?: string;
  start_at: string;
  end_at: string;
  status: string;
};

export type Dentist = {
  dentist_id: string;
  name: string;
  qualifications: { qualification_id: string; name: string; valid_from: string | null; valid_until: string | null }[];
};

export type AppointmentSummary = {
  appointment_id: string;
  appointment_no: string;
  dentist_id: string;
  clinic_id: string;
  start_at: string;
  end_at: string;
  status: string;
  patient_display?: string;
  same_clinic_options?: { start_at: string; end_at: string }[];
};

export const shiftLabels: Record<string, string> = {
  DRAFT: "草案", PENDING: "待牙医确认", ACCEPTED: "已接受",
  REJECTED: "已拒绝", PUBLISHED: "已发布", CANCELLED: "已撤销",
};

const chinaDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const chinaTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export const localDate = (value: Date | string) => chinaDate.format(new Date(value));
export const localTime = (value: string) => chinaTime.format(new Date(value));

export function addDays(value: string, offset: number) {
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function toOffset(value: FormDataEntryValue | null) {
  return typeof value === "string" && value ? value + ":00+08:00" : undefined;
}
