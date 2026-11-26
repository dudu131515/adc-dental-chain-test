import { Appointment, Chair, FundsStatus } from "../schedule/appointmentTypes";

export type AllergyEntry = { allergen: string; notes?: string | null };
export type ReviewStatus = "UNVERIFIED" | "NONE_KNOWN" | "KNOWN";
export type AllergyReview = {
  review_id: string; appointment_id: string; status: Exclude<ReviewStatus, "UNVERIFIED">;
  dentist_name: string; reviewed_at: string; changes: { added: number; updated: number; removed: number };
};
export type AllergyReviewState = { version: string; status: ReviewStatus; history: AllergyReview[] };

export type Visit = {
  main_dentist_id?: string;
  can_issue_invoice?: boolean;
  allergy_reviews?: AllergyReview[];
  visit_id: string; appointment_id: string; appointment_no: string; patient_display?: { name: string };
  clinic_name?: string; dentist_name?: string; status: string; started_at: string; ended_at?: string;
  chair?: Chair; refund?: FundsStatus; clinical_notes?: string; termination_reason?: string;
  estimated_amount: string;
  invoice_id?: string;
  planned_treatment_type_id: string;
  additional_decisions?: { decision_id: string; treatment_type_id: string; decision: string }[];
  treatment_items: { item_id: string; treatment_type_id: string; name: string; units: string; unit: string; unit_price: string; amount: string }[];
  materials?: { usage_id: string; item_id: string; name: string; unit: string; quantity: string; unit_cost: string }[];
};
export type ClinicalContext = {
  appointment: Appointment; chair: Chair | null; special_requirement: string | null;
  allergies: AllergyEntry[];
  allergy_review: AllergyReviewState;
  history: { visit_id: string; status: string; ended_at: string; treatments?: string[]; can_open_detail?: boolean }[];
};

export const visitStates: Record<string, string> = { IN_PROGRESS: "诊疗中", COMPLETED: "正常结束", TERMINATED: "已中止" };
