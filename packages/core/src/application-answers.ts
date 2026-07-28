import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareAvailabilityAnswer, type AvailabilityLocale } from "./availability";

export type AnswerStatus = "known" | "ask" | "user_decision";
export type WorkAuthorizationIntent = "sponsorship" | "authorized_to_work";
export type AnswerCategory =
  | "identity" | "contact" | "availability" | "work_authorization"
  | "legal_declaration" | "consent" | "salary" | "relocation" | "other";
export type PageBlocker = "captcha" | "otp" | "login" | "e_signature";

export type ApplicationAnswer = {
  field: string;
  proposed_value: string | null;
  source_evidence: string[];
  status: AnswerStatus;
  sensitive: boolean;
  last_confirmed_date: string | null;
  required: boolean;
  category: AnswerCategory;
  question_intent?: WorkAuthorizationIntent;
  comment_supported?: boolean;
};

export type ApplicationAnswerMatrix = {
  mode: "prepare_only";
  fields: ApplicationAnswer[];
  page_blockers: PageBlocker[];
  blockers: string[];
  submit_authorized: false;
};

const statuses = new Set<AnswerStatus>(["known", "ask", "user_decision"]);
const categories = new Set<AnswerCategory>([
  "identity", "contact", "availability", "work_authorization",
  "legal_declaration", "consent", "salary", "relocation", "other",
]);
const pageBlockers = new Set<PageBlocker>(["captcha", "otp", "login", "e_signature"]);
const decisionCategories = new Set<AnswerCategory>(["work_authorization", "legal_declaration", "consent", "salary", "relocation"]);
const workAuthorizationIntents = new Set<WorkAuthorizationIntent>(["sponsorship", "authorized_to_work"]);

export const workAuthorizationWording = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../config/work-authorization-wording.json"), "utf8"),
) as Readonly<{ en: string; de: string }>;

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  return value.trim() || null;
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseField(value: unknown, index: number): ApplicationAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`fields[${index}] must be an object`);
  const row = value as Record<string, unknown>;
  if (typeof row.field !== "string" || !row.field.trim()) throw new Error(`fields[${index}].field is required`);
  if (!statuses.has(row.status as AnswerStatus)) throw new Error(`fields[${index}].status must be known, ask, or user_decision`);
  if (!categories.has(row.category as AnswerCategory)) throw new Error(`fields[${index}].category is invalid`);
  if (typeof row.required !== "boolean" || typeof row.sensitive !== "boolean") throw new Error(`fields[${index}] requires boolean required and sensitive flags`);
  if (!Array.isArray(row.source_evidence) || !row.source_evidence.every((item) => typeof item === "string")) {
    throw new Error(`fields[${index}].source_evidence must be a string array`);
  }
  const lastConfirmed = optionalString(row.last_confirmed_date, `fields[${index}].last_confirmed_date`);
  if (lastConfirmed && !validIsoDate(lastConfirmed)) throw new Error(`fields[${index}].last_confirmed_date must be a valid YYYY-MM-DD date or null`);
  const sourceEvidence = (row.source_evidence as string[]).map((item) => item.trim()).filter(Boolean);
  const questionIntent = row.question_intent as WorkAuthorizationIntent | undefined;
  if (questionIntent !== undefined && !workAuthorizationIntents.has(questionIntent)) {
    throw new Error(`fields[${index}].question_intent is invalid`);
  }
  if (row.comment_supported !== undefined && typeof row.comment_supported !== "boolean") {
    throw new Error(`fields[${index}].comment_supported must be boolean`);
  }
  return {
    field: row.field.trim(),
    proposed_value: optionalString(row.proposed_value, `fields[${index}].proposed_value`),
    source_evidence: sourceEvidence,
    status: row.status as AnswerStatus,
    sensitive: row.sensitive,
    last_confirmed_date: lastConfirmed,
    required: row.required,
    category: row.category as AnswerCategory,
    ...(questionIntent ? { question_intent: questionIntent } : {}),
    ...(typeof row.comment_supported === "boolean" ? { comment_supported: row.comment_supported } : {}),
  };
}

function hasConfirmedPlannedAuthorization(profile: Record<string, unknown>): boolean {
  const legal = profile.legal;
  if (!legal || typeof legal !== "object" || Array.isArray(legal)) return false;
  const wrapper = (legal as Record<string, unknown>).work_authorization;
  if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return false;
  const record = wrapper as Record<string, unknown>;
  if (!["user_confirmed", "document_verified"].includes(String(record.verification_status))) return false;
  const value = record.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const authorization = value as Record<string, unknown>;
  return authorization.status === "planned_after_arrival"
    && authorization.basis === "§24 AufenthG (temporary protection)"
    && authorization.employment_access === "full_once_issued"
    && authorization.sponsorship_required === false
    && authorization.available_from === "2026-08-17";
}

function prepareWorkAuthorizationAnswer(
  row: ApplicationAnswer,
  profile: Record<string, unknown>,
  locale: AvailabilityLocale,
): ApplicationAnswer | null {
  if (!hasConfirmedPlannedAuthorization(profile) || !row.question_intent) return null;
  const sourceEvidence = [
    "profile.legal.work_authorization",
    "profile.availability.available_from",
  ];
  if (row.question_intent === "sponsorship") {
    return {
      ...row,
      proposed_value: locale === "de" ? "Nein" : "No",
      source_evidence: sourceEvidence,
      status: "known",
      sensitive: false,
    };
  }
  if (row.comment_supported) {
    return {
      ...row,
      proposed_value: locale === "de"
        ? "Ja — verfügbar ab 17. August 2026 mit geplanter §24-Aufenthaltserlaubnis; kein Arbeitgeber-Sponsoring erforderlich."
        : "Yes — available to start from 17 August 2026 under planned §24 authorization; no employer sponsorship required.",
      source_evidence: sourceEvidence,
      status: "known",
      sensitive: false,
    };
  }
  return null;
}

export function prepareApplicationAnswerMatrix(
  input: unknown,
  profile: Record<string, unknown>,
  asOfDate: string,
  locale: AvailabilityLocale,
): ApplicationAnswerMatrix {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("answer matrix input must be an object");
  const source = input as Record<string, unknown>;
  if (!Array.isArray(source.fields)) throw new Error("answer matrix input requires fields");
  const blockersInput = source.page_blockers ?? [];
  if (!Array.isArray(blockersInput) || !blockersInput.every((item) => pageBlockers.has(item as PageBlocker))) {
    throw new Error("page_blockers may contain only captcha, otp, login, or e_signature");
  }

  const fields = source.fields.map(parseField).map((row) => {
    if (row.category === "availability") {
      const availability = prepareAvailabilityAnswer(profile, asOfDate, locale);
      return availability
        ? { ...row, proposed_value: availability.proposedValue, source_evidence: availability.source, status: "known" as const, sensitive: false, last_confirmed_date: availability.lastConfirmedDate }
        : { ...row, proposed_value: null, source_evidence: [], status: "ask" as const };
    }
    if (row.category === "work_authorization") {
      return prepareWorkAuthorizationAnswer(row, profile, locale)
        ?? { ...row, proposed_value: null, source_evidence: [], status: "user_decision" as const, sensitive: true };
    }
    if (decisionCategories.has(row.category)) {
      return { ...row, proposed_value: null, status: "user_decision" as const, sensitive: true };
    }
    if (row.status === "known" && (row.proposed_value === null || row.source_evidence.length === 0)) {
      return { ...row, status: "ask" as const };
    }
    return row;
  });

  const blockers = [
    ...fields.filter((row) => row.status === "user_decision").map((row) => `${row.field}: explicit user decision required`),
    ...fields.filter((row) => row.required && row.status !== "known").map((row) => `${row.field}: required answer is not confirmed`),
    ...(blockersInput as PageBlocker[]).map((blocker) => `${blocker}: manual stop required`),
  ];
  return {
    mode: "prepare_only",
    fields,
    page_blockers: blockersInput as PageBlocker[],
    blockers: [...new Set(blockers)],
    submit_authorized: false,
  };
}
