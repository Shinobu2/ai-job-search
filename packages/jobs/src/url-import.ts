import type { StorageRepository } from "../../storage/src/repository";
import { canonicalHttpUrl } from "../../core/src/canonical-url";
import { importVacancy, visibleHtmlText } from "./import";
import type { ImportedJob } from "./types";

export const URL_IMPORT_TIMEOUT_MS = 15_000;
export const URL_IMPORT_HOST_DELAY_MS = 1_000;
export const URL_IMPORT_USER_AGENT = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/126.0.0.0 Safari/537.36",
  "CareerControlRoom/0.1",
].join(" ");

const ROBOT_NAME = "CareerControlRoom";

type JsonObject = Record<string, unknown>;
type SalaryValue = string | number;

export type MappedJobPosting = {
  title: string | null;
  company: string | null;
  location: {
    addressLocality: string | null;
    addressRegion: string | null;
    addressCountry: string | null;
  } | null;
  datePosted: string | null;
  validThrough: string | null;
  employmentType: string | string[] | null;
  baseSalary: {
    amount: SalaryValue | null;
    minValue: SalaryValue | null;
    maxValue: SalaryValue | null;
    unitText: string | null;
  } | null;
  description: string | null;
  directApply: boolean | null;
  identifier: string | null;
};

export type UrlImportSource = "json-ld" | "model-fallback";
export type UrlImportedJob = ImportedJob & { importSource: UrlImportSource };
export type UrlImportOptions = {
  fetcher?: typeof fetch;
  warn?: (message: string) => void;
};
export type UrlImportSessionOptions = UrlImportOptions & {
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};
export type UrlImportSession = {
  importVacancyFromUrl: (
    url: string,
    repository: StorageRepository,
  ) => Promise<UrlImportedJob>;
};

type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };
type UrlImportSessionState = {
  robotsByOrigin: Map<string, Promise<string | null>>;
  lastRequestAtByHost: Map<string, number>;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function salaryValue(value: unknown): SalaryValue | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function firstObject(value: unknown): JsonObject | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = object(item);
      if (candidate) return candidate;
    }
    return null;
  }
  return object(value);
}

function isJobPosting(value: JsonObject): boolean {
  const type = value["@type"];
  const matches = (candidate: unknown): boolean => typeof candidate === "string"
    && candidate.toLowerCase().split(/[\/#]/).at(-1) === "jobposting";
  return Array.isArray(type) ? type.some(matches) : matches(type);
}

function findJobPosting(value: unknown): JsonObject | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }

  const record = object(value);
  if (!record) return null;
  if (isJobPosting(record)) return record;
  if ("@graph" in record) {
    const found = findJobPosting(record["@graph"]);
    if (found) return found;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key === "@graph") continue;
    const found = findJobPosting(nested);
    if (found) return found;
  }
  return null;
}

function scriptType(attributes: string): string | null {
  const match = attributes.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim().toLowerCase() || null;
}

function countryValue(value: unknown): string | null {
  return textValue(value) ?? textValue(object(value)?.name);
}

function mapJobPosting(posting: JsonObject): MappedJobPosting {
  const organization = firstObject(posting.hiringOrganization);
  const place = firstObject(posting.jobLocation);
  const address = firstObject(place?.address);
  const hasLocation = place !== null || address !== null;
  const salary = firstObject(posting.baseSalary);
  const quantitative = salary ? firstObject(salary.value) : null;
  const directApply = typeof posting.directApply === "boolean" ? posting.directApply : null;
  const employmentTypes = Array.isArray(posting.employmentType)
    ? posting.employmentType.map(textValue).filter((value): value is string => value !== null)
    : null;
  const description = textValue(posting.description);
  const identifier = firstObject(posting.identifier);

  return {
    title: textValue(posting.title),
    company: textValue(organization?.name),
    location: hasLocation
      ? {
          addressLocality: textValue(address?.addressLocality),
          addressRegion: textValue(address?.addressRegion),
          addressCountry: countryValue(address?.addressCountry),
        }
      : null,
    datePosted: textValue(posting.datePosted),
    validThrough: textValue(posting.validThrough),
    employmentType: employmentTypes
      ? employmentTypes.length > 0 ? employmentTypes : null
      : textValue(posting.employmentType),
    baseSalary: salary
      ? {
          amount: quantitative
            ? salaryValue(quantitative.value ?? quantitative.amount)
            : salaryValue(salary.value),
          minValue: salaryValue(quantitative?.minValue),
          maxValue: salaryValue(quantitative?.maxValue),
          unitText: textValue(quantitative?.unitText),
        }
      : null,
    description: description
      ? visibleHtmlText(description)
          .replace(/[ \t]+([,.;:!?])/g, "$1")
          .replace(/\n{2,}/g, "\n") || null
      : null,
    directApply,
    identifier: textValue(identifier?.value),
  };
}

export function extractJobPostingJsonLd(html: string): MappedJobPosting | null {
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scripts)) {
    if (scriptType(match[1]) !== "application/ld+json") continue;
    const raw = match[2].trim().replace(/^\ufeff/, "").replace(/^<!--\s*/, "").replace(/\s*-->$/, "");
    try {
      const posting = findJobPosting(JSON.parse(raw));
      if (posting) return mapJobPosting(posting);
    } catch {
      // A malformed block does not prevent trying the remaining JSON-LD scripts.
    }
  }
  return null;
}

function parseRobots(robotsText: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const directive = line.match(/^([^:]+):(.*)$/);
    if (!directive) continue;
    const name = directive[1].trim().toLowerCase();
    const value = directive[2].trim();

    if (name === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }
    if ((name === "allow" || name === "disallow") && current?.agents.length) {
      if (value) current.rules.push({ allow: name === "allow", pattern: value });
    }
  }
  return groups;
}

function groupAgentScore(group: RobotsGroup, userAgent: string): number {
  const normalized = userAgent.toLowerCase();
  let score = -1;
  for (const agent of group.agents) {
    if (agent === "*") score = Math.max(score, 0);
    else if (normalized === agent) score = Math.max(score, agent.length);
  }
  return score;
}

function robotsPatternMatches(pattern: string, targetPath: string): boolean {
  const endAnchored = pattern.endsWith("$");
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${endAnchored ? "$" : ""}`).test(targetPath);
}

export function robotsAllows(robotsText: string, userAgent: string, targetPath: string): boolean {
  const groups = parseRobots(robotsText);
  const scores = groups.map((group) => groupAgentScore(group, userAgent));
  const bestScore = Math.max(-1, ...scores);
  if (bestScore < 0) return true;

  let selected: RobotsRule | null = null;
  for (let index = 0; index < groups.length; index += 1) {
    if (scores[index] !== bestScore) continue;
    for (const rule of groups[index].rules) {
      if (!robotsPatternMatches(rule.pattern, targetPath)) continue;
      if (!selected || rule.pattern.length > selected.pattern.length || (
        rule.pattern.length === selected.pattern.length && rule.allow
      )) {
        selected = rule;
      }
    }
  }
  return selected?.allow ?? true;
}

function requestError(label: string, error: unknown): Error {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Error(`${label} timed out after ${URL_IMPORT_TIMEOUT_MS / 1_000} seconds`);
  }
  return new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
}

async function get(
  url: string,
  label: string,
  fetcher: typeof fetch,
): Promise<Response> {
  try {
    return await fetcher(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": URL_IMPORT_USER_AGENT,
      },
      signal: AbortSignal.timeout(URL_IMPORT_TIMEOUT_MS),
    });
  } catch (error) {
    throw requestError(label, error);
  }
}

async function fetchRobotsText(
  robotsUrl: string,
  fetcher: typeof fetch,
  warn: (message: string) => void,
  session: UrlImportSessionState | undefined,
): Promise<string | null> {
  let response: Response;
  try {
    await paceRequest(new URL(robotsUrl).host, session);
    response = await get(robotsUrl, "robots.txt request", fetcher);
  } catch (error) {
    warn(`Unable to read ${robotsUrl}; continuing: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  if (!response.ok) {
    if (response.status !== 404 && response.status !== 410) {
      warn(`Unable to read ${robotsUrl}; continuing after HTTP ${response.status}`);
    }
    return null;
  }

  try {
    return await response.text();
  } catch (error) {
    warn(`Unable to read ${robotsUrl}; continuing: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function robotsTextForOrigin(
  origin: string,
  fetcher: typeof fetch,
  warn: (message: string) => void,
  session: UrlImportSessionState | undefined,
): Promise<string | null> {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  if (!session) return fetchRobotsText(robotsUrl, fetcher, warn, undefined);

  const cached = session.robotsByOrigin.get(origin);
  if (cached) return cached;
  const pending = fetchRobotsText(robotsUrl, fetcher, warn, session);
  session.robotsByOrigin.set(origin, pending);
  return pending;
}

async function paceRequest(
  host: string,
  session: UrlImportSessionState | undefined,
): Promise<void> {
  if (!session) return;
  const previous = session.lastRequestAtByHost.get(host);
  if (previous !== undefined) {
    const remaining = URL_IMPORT_HOST_DELAY_MS - (session.now() - previous);
    if (remaining > 0) await session.sleep(remaining);
  }
  session.lastRequestAtByHost.set(host, session.now());
}

function renderedPosting(posting: MappedJobPosting): string {
  const lines: string[] = [];
  const location = posting.location
    ? [
        posting.location.addressLocality,
        posting.location.addressRegion,
        posting.location.addressCountry,
      ].filter((value): value is string => value !== null).join(", ") || null
    : null;
  if (posting.title !== null) lines.push(`Title: ${posting.title}`);
  if (posting.company !== null) lines.push(`Company: ${posting.company}`);
  if (location !== null) lines.push(`Location: ${location}`);
  if (posting.datePosted !== null) lines.push(`Date posted: ${posting.datePosted}`);
  if (posting.validThrough !== null) lines.push(`Valid through: ${posting.validThrough}`);
  if (posting.employmentType !== null) {
    lines.push(`Employment type: ${Array.isArray(posting.employmentType) ? posting.employmentType.join(", ") : posting.employmentType}`);
  }
  if (posting.baseSalary !== null) {
    if (posting.baseSalary.amount !== null) lines.push(`Base salary amount: ${posting.baseSalary.amount}`);
    if (posting.baseSalary.minValue !== null) lines.push(`Base salary minimum: ${posting.baseSalary.minValue}`);
    if (posting.baseSalary.maxValue !== null) lines.push(`Base salary maximum: ${posting.baseSalary.maxValue}`);
    if (posting.baseSalary.unitText !== null) lines.push(`Base salary unit: ${posting.baseSalary.unitText}`);
  }
  if (posting.directApply !== null) lines.push(`Direct apply: ${posting.directApply}`);
  if (posting.identifier !== null) lines.push(`Identifier: ${posting.identifier}`);
  if (posting.description !== null) lines.push(`Description:\n${posting.description}`);
  return lines.join("\n");
}

function postingLocation(posting: MappedJobPosting): string | null {
  if (!posting.location) return null;
  return [
    posting.location.addressLocality,
    posting.location.addressRegion,
    posting.location.addressCountry,
  ].filter((value): value is string => value !== null).join(", ") || null;
}

async function importVacancyFromUrlWithSession(
  url: string,
  repository: StorageRepository,
  options: UrlImportOptions,
  session: UrlImportSessionState | undefined,
): Promise<UrlImportedJob> {
  const canonicalUrl = canonicalHttpUrl(url);
  if (!canonicalUrl) throw new Error(`Invalid job URL: ${url}`);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`Invalid job URL: ${url}`);
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)) throw new Error(`Job URL must use http or https: ${url}`);
  if (target.username || target.password) throw new Error("Job URL must not contain credentials");

  const fetcher = options.fetcher ?? fetch;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const robotsText = await robotsTextForOrigin(target.origin, fetcher, warn, session);
  if (robotsText !== null && !robotsAllows(robotsText, ROBOT_NAME, `${target.pathname}${target.search}`)) {
    throw new Error(`robots.txt disallows fetching ${target.pathname}`);
  }

  await paceRequest(target.host, session);
  let pageResponse = await get(url, "Job page request", fetcher);
  if ((pageResponse.status === 404 || pageResponse.status === 410) && canonicalUrl !== url) {
    await pageResponse.body?.cancel();
    await paceRequest(new URL(canonicalUrl).host, session);
    pageResponse = await get(canonicalUrl, "Job page request", fetcher);
  }
  if (!pageResponse.ok) throw new Error(`Job page request failed: HTTP ${pageResponse.status}`);
  const html = await pageResponse.text();
  const posting = extractJobPostingJsonLd(html);
  if (posting) {
    const imported = await importVacancy({
      text: renderedPosting(posting),
      sourceUrl: url,
      sourceId: posting.identifier ? `json-ld:${target.hostname}:${posting.identifier}` : undefined,
      sourceType: "json-ld",
      identity: {
        title: posting.title,
        company: posting.company,
        location: postingLocation(posting),
      },
    }, repository);
    return { ...imported, importSource: "json-ld" };
  }

  const text = visibleHtmlText(html);
  const imported = await importVacancy({
    text,
    sourceUrl: url,
    sourceType: "model-fallback",
  }, repository);
  return { ...imported, importSource: "model-fallback" };
}

export async function importVacancyFromUrl(
  url: string,
  repository: StorageRepository,
  options: UrlImportOptions = {},
): Promise<UrlImportedJob> {
  return importVacancyFromUrlWithSession(url, repository, options, undefined);
}

export function createUrlImportSession(
  options: UrlImportSessionOptions = {},
): UrlImportSession {
  const state: UrlImportSessionState = {
    robotsByOrigin: new Map(),
    lastRequestAtByHost: new Map(),
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
  };
  return {
    importVacancyFromUrl: (url, repository) => importVacancyFromUrlWithSession(
      url,
      repository,
      options,
      state,
    ),
  };
}
