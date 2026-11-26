import type { Demand } from "./ShiftDemandForm";
import type { Dentist, Shift } from "./types";

export type ClinicOption = { clinic_id: string; name: string };
export type BoardDentist = Dentist & { clinic_ids?: string[] };
export type BoardShift = Shift & { clinic_name?: string; dentist_name?: string; rejection_reason?: string };
export type Shortage = Demand & { assigned_count: number; missing_count: number };
export type ShiftConflict = {
  code: "CROSS_CLINIC_OVERLAP" | "CROSS_CLINIC_TRAVEL" | "SHIFT_OVERLAP";
  dentist_id: string;
  shift_ids: string[];
  clinic_ids: string[];
};
export type WeeklySchedule = { shifts: BoardShift[]; shortages?: Shortage[]; conflicts?: ShiftConflict[] };

export type DraftContext = {
  day: string;
  clinicId?: string;
  dentistId?: string;
  demand?: Demand;
};

type DraftFields = { clinic_id: string; dentist_id: string; start_at: string; end_at: string };
export type BatchAction =
  | { action: "draft"; shifts: DraftFields[] }
  | { action: "copy"; source_shift_id: string; target_date: string }
  | { action: "reuse_week"; target_week: string; clinic_id?: string; dentist_id?: string }
  | { action: "submit" | "publish"; shifts: { shift_id: string; route_feasible?: true; evidence_ref?: string }[] };
export type BatchResult = { items: BoardShift[]; skipped_count: number };
export type RunBatch = (action: BatchAction, onSuccess?: (result: BatchResult) => void) => Promise<void>;

export const conflictLabels = {
  CROSS_CLINIC_OVERLAP: "跨店班次重叠",
  CROSS_CLINIC_TRAVEL: "跨店转场不足 60 分钟",
  SHIFT_OVERLAP: "同店班次重叠",
};

export function dentistsAt(dentists: BoardDentist[], clinic: string) {
  return dentists.filter(person => !person.clinic_ids || person.clinic_ids.includes(clinic));
}
