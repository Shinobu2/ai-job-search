import type { Database } from "bun:sqlite";
import type {
  ApplicationEventRecord,
  ApplicationRecord,
  CurrentVacancy,
  StorageRepository,
} from "./repository";

export const GENERATED_STATUS_START = "<!-- generated:status:start -->";
export const GENERATED_STATUS_END = "<!-- generated:status:end -->";

export type HandoffApplication = ApplicationRecord & {
  logical_vacancy_id: string | null;
  public_reference: string;
  job: {
    id: string;
    title: string | null;
    company: string | null;
    location: string | null;
    raw_snapshot_hash: string;
  } | null;
  events: ApplicationEventRecord[];
};

export type HandoffState = {
  schema_version: 1;
  generated_at: string;
  vacancies: CurrentVacancy[];
  applications: HandoffApplication[];
};

type ApplicationIdentity = {
  job_id: string;
  logical_vacancy_id: string | null;
  source_locator: string | null;
};

function publicReference(sourceLocator: string | null, jobId: string): string {
  const explicit = sourceLocator?.startsWith("source-id:")
    ? sourceLocator.slice("source-id:".length).trim()
    : null;
  return explicit || jobId;
}

export function readHandoffState(
  db: Database,
  repository: StorageRepository,
  generatedAt = new Date().toISOString(),
): HandoffState {
  const identities = db.query(
    `SELECT
       application.job_id,
       version.logical_vacancy_id,
       source.source_locator
     FROM applications application
     JOIN jobs job ON job.id = application.job_id
     JOIN job_sources source ON source.id = job.source_id
     LEFT JOIN vacancy_versions version ON version.job_id = application.job_id
     ORDER BY application.created_at, application.job_id`,
  ).all() as ApplicationIdentity[];
  const identityByJob = new Map(identities.map((identity) => [identity.job_id, identity]));
  const applications = repository.listApplications().map((application): HandoffApplication => {
    const storedJob = repository.readJob(application.job_id);
    const identity = identityByJob.get(application.job_id);
    return {
      ...application,
      logical_vacancy_id: identity?.logical_vacancy_id ?? null,
      public_reference: publicReference(identity?.source_locator ?? null, application.job_id),
      job: storedJob
        ? {
            id: storedJob.id,
            title: storedJob.title,
            company: storedJob.company,
            location: storedJob.location,
            raw_snapshot_hash: storedJob.rawSnapshotHash,
          }
        : null,
      events: repository.listApplicationEvents(application.job_id),
    };
  });

  return {
    schema_version: 1,
    generated_at: generatedAt,
    vacancies: repository.listCurrentVacancies(),
    applications,
  };
}

function inline(value: string | null | undefined, fallback = "unknown"): string {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

export function renderPrivateHandoff(state: HandoffState): string {
  const vacancySections = state.vacancies.map((vacancy) => [
    `## ${inline(vacancy.company)} — ${inline(vacancy.title)}`,
    "",
    `- Logical vacancy: ${inline(vacancy.logicalVacancyId)}`,
    `- Job snapshot: ${inline(vacancy.jobId)} · version ${vacancy.version}`,
    `- Location: ${inline(vacancy.location)}`,
    `- Lifecycle: ${inline(vacancy.lifecycleStatus)}`,
    `- Canonical URL: ${inline(vacancy.canonicalUrl, "none")}`,
    `- First seen: ${inline(vacancy.firstSeenAt)}`,
    `- Last seen: ${inline(vacancy.lastSeenAt)}`,
    `- Consecutive misses: ${vacancy.consecutiveMisses}`,
  ].join("\n"));
  const applicationSections = state.applications.map((application) => {
    const eventLines = application.events.length > 0
      ? application.events.map((event) =>
          `- ${inline(event.created_at)} — ${inline(event.status)} — ${inline(event.actor)}${event.note ? ` — ${inline(event.note)}` : ""}`)
      : ["- None"];
    return [
      `## ${inline(application.job?.company)} — ${inline(application.job?.title)}`,
      "",
      `- Vacancy: ${inline(application.public_reference)}`,
      `- Job snapshot: ${inline(application.job_id)}`,
      `- Status: ${inline(application.status)}`,
      `- Location: ${inline(application.job?.location)}`,
      `- Next action: ${inline(application.next_action, "none")}`,
      `- Document directory: ${inline(application.document_dir, "none")}`,
      `- Created: ${inline(application.created_at)}`,
      `- Updated: ${inline(application.updated_at)}`,
      "",
      "### Application events",
      "",
      ...eventLines,
    ].join("\n");
  });

  return [
    "# Private job-search handoff",
    "",
    `Generated: ${state.generated_at}`,
    `Current vacancies: ${state.vacancies.length}`,
    `Tracked applications: ${state.applications.length}`,
    "",
    "# Current vacancies",
    "",
    ...(vacancySections.length > 0 ? vacancySections : ["No current vacancies."]),
    "",
    "# Applications",
    "",
    ...(applicationSections.length > 0 ? applicationSections : ["No tracked applications."]),
    "",
  ].join("\n");
}

function publicValue(value: string | null | undefined, fallback: string): string {
  return inline(value, fallback)
    .replace(/[<>]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/[`*_[\]]/g, (character) => `\\${character}`);
}

function publicCode(value: string | null | undefined, fallback: string): string {
  return inline(value, fallback).replace(/[<>`\\]/g, "");
}

export function renderSanitizedStatus(state: HandoffState): string {
  const statusCounts = new Map<string, number>();
  for (const application of state.applications) {
    statusCounts.set(application.status, (statusCounts.get(application.status) ?? 0) + 1);
  }
  const counts = [...statusCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${publicValue(status, "unknown")}: ${count}`)
    .join(" · ") || "none";
  const applicationRows = [...state.applications]
    .sort((left, right) =>
      publicValue(left.job?.company, "Unknown company")
        .localeCompare(publicValue(right.job?.company, "Unknown company"))
      || publicCode(left.public_reference, "unknown")
        .localeCompare(publicCode(right.public_reference, "unknown")))
    .map((application) =>
      `- ${publicValue(application.job?.company, "Unknown company")} — \`${publicCode(application.public_reference, "unknown")}\``);

  return [
    "### Generated tracker status",
    "",
    `- Status counts: ${counts}`,
    "",
    "Companies and vacancy numbers:",
    "",
    ...(applicationRows.length > 0 ? applicationRows : ["- No tracked applications"]),
  ].join("\n");
}

export function replaceGeneratedStatus(
  handoff: string,
  sanitizedStatus: string,
): string {
  const startCount = handoff.split(GENERATED_STATUS_START).length - 1;
  const endCount = handoff.split(GENERATED_STATUS_END).length - 1;
  const start = handoff.indexOf(GENERATED_STATUS_START);
  const end = handoff.indexOf(GENERATED_STATUS_END);
  if (startCount !== 1 || endCount !== 1 || start > end) {
    throw new Error("CHATGPT_WORK_HANDOFF.md requires exactly one generated status marker pair");
  }
  const newline = handoff.includes("\r\n") ? "\r\n" : "\n";
  const contentStart = start + GENERATED_STATUS_START.length;
  return [
    handoff.slice(0, contentStart),
    newline,
    sanitizedStatus.trim().replace(/\r?\n/g, newline),
    newline,
    handoff.slice(end),
  ].join("");
}
