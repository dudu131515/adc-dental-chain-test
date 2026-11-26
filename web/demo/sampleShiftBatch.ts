import type { Demand } from "../src/features/schedule/ShiftDemandForm";
import type { BoardShift, ShiftConflict, Shortage } from "../src/features/schedule/shiftBoardTypes";
import { addDays, localDate } from "../src/features/schedule/types";
import { ApiError } from "../src/shared/api";

const SHIFT_STATES = ["DRAFT", "PENDING", "ACCEPTED", "PUBLISHED"];
const DAY = 24 * 60 * 60 * 1000;
const TRANSFER = 60 * 60 * 1000;

type Body = Record<string, unknown>;
type BatchOptions = {
  shifts: BoardShift[];
  nextId: () => string;
  need: (role: string, clinic?: string) => void;
  canReuse?: (shift: BoardShift) => boolean;
  validateDraft: (shift: BoardShift) => void;
  validateShift: (shift: BoardShift, routeVerified?: boolean, publishing?: boolean) => void;
  problem: (status: number, message: string) => never;
};

function withDetails(error: unknown, details: Record<string, string | number>): never {
  if (error instanceof ApiError) {
    throw new ApiError(error.status, { ...error.error, details: { ...error.error.details, ...details } });
  }
  throw error;
}

function validDate(value: unknown, problem: BatchOptions["problem"]): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return problem(400, "请填写有效的目标日期。");
  const stamp = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) {
    return problem(400, "请填写有效的目标日期。");
  }
  return value;
}

function shifted(value: string, days: number) {
  return new Date(Date.parse(value) + days * DAY + 8 * 60 * 60 * 1000).toISOString().replace(/Z$/, "+08:00");
}

function clone(shift: BoardShift, days: number): Body {
  return {
    clinic_id: shift.clinic_id, dentist_id: shift.dentist_id,
    start_at: shifted(shift.start_at, days), end_at: shifted(shift.end_at, days),
  };
}

export function runSampleShiftBatch(body: Body, options: BatchOptions) {
  const { shifts, nextId, need, canReuse, validateShift, validateDraft, problem } = options;
  need("HQ_SCHEDULER");
  const action = body.action;
  const rows = Array.isArray(body.shifts) ? body.shifts as Body[] : [];
  const items: BoardShift[] = [];
  let skipped_count = 0;
  const length = shifts.length;
  const changed: { row: BoardShift; status: string }[] = [];

  function source(id: unknown) {
    const row = shifts.find(item => item.shift_id === String(id ?? ""));
    if (!row) return problem(404, "找不到可办理的班次。");
    need("HQ_SCHEDULER", row.clinic_id);
    return row;
  }

  function draft(data: Body, index: number) {
    try {
      const clinic_id = String(data.clinic_id ?? "");
      const dentist_id = String(data.dentist_id ?? "");
      const start_at = String(data.start_at ?? "");
      const end_at = String(data.end_at ?? "");
      if (!Number.isFinite(Date.parse(start_at)) || !Number.isFinite(Date.parse(end_at)) || Date.parse(end_at) <= Date.parse(start_at)) {
        problem(400, "请填写有效的开始和结束时间。");
      }
      need("HQ_SCHEDULER", clinic_id);
      const row: BoardShift = {
        shift_id: "", status: "DRAFT", clinic_id, dentist_id, start_at, end_at,
        demand_id: data.demand_id ? String(data.demand_id) : undefined,
      };
      validateDraft(row);
      if (shifts.some(existing => SHIFT_STATES.includes(existing.status) && existing.clinic_id === clinic_id &&
        existing.dentist_id === dentist_id && Date.parse(existing.start_at) === Date.parse(start_at) &&
        Date.parse(existing.end_at) === Date.parse(end_at))) {
        skipped_count += 1;
        return;
      }
      row.shift_id = nextId();
      shifts.push(row);
      items.push(row);
    } catch (error) {
      withDetails(error, { row: index + 1 });
    }
  }

  try {
    if (action === "copy") {
      const row = source(body.source_shift_id);
      if (row.status === "CANCELLED") problem(409, "已撤销班次不能复制。");
      const date = validDate(body.target_date, problem);
      const days = (Date.parse(date) - Date.parse(localDate(row.start_at))) / DAY;
      draft(clone(row, days), 0);
    } else if (action === "reuse_week") {
      const date = validDate(body.target_week, problem);
      const clinic = body.clinic_id ? String(body.clinic_id) : null;
      const dentist = body.dentist_id ? String(body.dentist_id) : null;
      if (clinic) need("HQ_SCHEDULER", clinic);
      const first = addDays(date, -7);
      const previous = shifts.filter(row => {
        const start = localDate(row.start_at);
        return SHIFT_STATES.includes(row.status) && start >= first && start < date &&
          (!clinic || row.clinic_id === clinic) && (!dentist || row.dentist_id === dentist) && (canReuse?.(row) ?? true);
      }).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
      if (previous.length > 200) problem(400, "上一周班次过多，请按门店或牙医分批复用。");
      previous.map(row => clone(row, 7)).forEach(draft);
    } else if (action === "draft" || action === "submit" || action === "publish") {
      if (!rows.length || rows.length > 200 || rows.some(row => !row || typeof row !== "object")) {
        problem(400, "请选择 1 至 200 个班次。");
      }
      if (action === "draft") {
        rows.forEach(draft);
      } else {
        const ids = rows.map(row => String(row.shift_id ?? ""));
        if (new Set(ids).size !== ids.length) problem(400, "每个班次只能选择一次。");
        rows.forEach((data, index) => {
          try {
            const row = source(ids[index]);
            if (row.status !== (action === "submit" ? "DRAFT" : "ACCEPTED")) {
              problem(409, "当前班次状态不允许此操作。");
            }
            validateDraft(row);
            validateShift(row, data.route_feasible === true && Boolean(String(data.evidence_ref ?? "").trim()), action === "publish");
            changed.push({ row, status: row.status });
            row.status = action === "submit" ? "PENDING" : "PUBLISHED";
            items.push(row);
          } catch (error) {
            withDetails(error, { shift_id: ids[index] });
          }
        });
      }
    } else {
      problem(400, "未知的排班操作。");
    }
  } catch (error) {
    shifts.splice(length);
    changed.forEach(({ row, status }) => { row.status = status; });
    throw error;
  }
  return { items, skipped_count };
}

type InsightsOptions = {
  shifts: BoardShift[];
  demands: Demand[];
  visible: (shift: BoardShift) => boolean;
  canReadDemand: (clinicId: string) => boolean;
  canQualify?: (shift: BoardShift, demand: Demand) => boolean;
  clinicId?: string | null;
  dentistId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

export function sampleShiftInsights({
  shifts, demands, visible, canReadDemand, canQualify, clinicId, dentistId, dateFrom, dateTo,
}: InsightsOptions): { shortages: Shortage[]; conflicts: ShiftConflict[] } {
  const start = dateFrom ? Date.parse(dateFrom + "T00:00:00+08:00") : -Infinity;
  const end = dateTo ? Date.parse(addDays(dateTo, 1) + "T00:00:00+08:00") : Infinity;
  const visibleRows = shifts.filter(row => visible(row) && SHIFT_STATES.includes(row.status)
    && (!dentistId || row.dentist_id === dentistId));
  const inWindow = (row: BoardShift) => (!clinicId || row.clinic_id === clinicId)
    && Date.parse(row.end_at) > start && Date.parse(row.start_at) < end;
  const candidates = visibleRows.filter(row => Date.parse(row.end_at) > start - TRANSFER && Date.parse(row.start_at) < end + TRANSFER)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const conflicts: ShiftConflict[] = [];
  candidates.forEach((first, index) => {
    for (const second of candidates.slice(index + 1)) {
      const gap = Date.parse(second.start_at) - Date.parse(first.end_at);
      if (gap >= TRANSFER) break;
      if (first.dentist_id !== second.dentist_id || (!inWindow(first) && !inWindow(second))) continue;
      const cross = first.clinic_id !== second.clinic_id;
      if (gap >= 0 && !cross) continue;
      conflicts.push({
        code: gap >= 0 ? "CROSS_CLINIC_TRAVEL" : cross ? "CROSS_CLINIC_OVERLAP" : "SHIFT_OVERLAP",
        dentist_id: first.dentist_id, shift_ids: [first.shift_id, second.shift_id], clinic_ids: [first.clinic_id, second.clinic_id],
      });
    }
  });

  const shortages = demands.filter(demand => (!clinicId || demand.clinic_id === clinicId) && canReadDemand(demand.clinic_id)
    && Date.parse(demand.start_at) < end && Date.parse(demand.end_at) > start).flatMap(demand => {
      const first = Date.parse(demand.start_at);
      const last = Date.parse(demand.end_at);
      const coverage = shifts.filter(row => row.clinic_id === demand.clinic_id && row.status === "PUBLISHED"
        && Date.parse(row.start_at) < last && Date.parse(row.end_at) > first && (canQualify?.(row, demand) ?? true));
      const endpoints = new Set([first, ...coverage.flatMap(row => [
        Math.max(first, Date.parse(row.start_at)), Math.min(last, Date.parse(row.end_at)),
      ])]);
      let assigned_count = demand.required_count;
      for (const moment of endpoints) {
        if (moment >= last) continue;
        const available = coverage.filter(row => Date.parse(row.start_at) <= moment && Date.parse(row.end_at) > moment);
        assigned_count = Math.min(assigned_count, new Set(available.map(row => row.dentist_id)).size);
      }
      const missing_count = demand.required_count - assigned_count;
      return missing_count ? [{ ...demand, assigned_count, missing_count }] : [];
    });
  return { shortages, conflicts };
}
