import { prepareAvailabilityAnswer, type AvailabilityLocale } from "./availability";

export type AnswerStatus = "known" | "ask" | "user_decision";
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
  return {
    field: row.field.trim(),
    proposed_value: optionalString(row.proposed_value, `fields[${index}].proposed_value`),
    source_evidence: sourceEvidence,
    status: row.status as AnswerStatus,
    sensitive: row.sensitive,
    last_confirmed_date: lastConfirmed,
    required: row.required,
    category: row.category as AnswerCategory,
  };
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
    if (decisionCategories.has(row.category)) {
      return { ...row, proposed_value: null, status: "user_decision" as const, sensitive: true };
    }
    if (row.status === "known" && (row.proposed_value === null || row.source_evidence.length === 0)) {
      return { ...row, status: "ask" as const };
    }
    return row;
  });

  const blockers = [
    ...fields.filter((row) => decisionCategories.has(row.category)).map((row) => `${row.field}: explicit user decision required`),
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
