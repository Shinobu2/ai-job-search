import type { WorkspaceSnapshot } from "../../core/src/types";
import type { EvaluationResult } from "../../jobs/src/types";
import type { StorageRepository } from "../../storage/src/repository";

export type SearchTrack = string;

export type SourceDiagnostic = {
  stage: "search" | "detail" | "parse";
  locator: string;
  code: string;
  message: string;
  transient: boolean;
};

export type DiscoveryCounters = {
  searched: number;
  detailed: number;
  imported: number;
  skipped: number;
  failed: number;
};

export type DiscoveryStatus = "success" | "partial" | "failed";

export type DiscoveryScopeSummary = { planned: number; completed: number; failed: number };

export type DiscoveredJob = {
  id: string;
  reused: boolean;
  sourceId: string;
  stableSourceId: string;
  sourceUrl: string;
  title: string;
  company: string | null;
  location: string | null;
  logicalVacancyId: string;
  version: number;
  track: SearchTrack;
  actionable: boolean;
  needs_review: boolean;
  evaluation?: EvaluationResult;
};

export type DiscoveryBatch = {
  sourceId: string;
  track: SearchTrack;
  status: DiscoveryStatus;
  scope: DiscoveryScopeSummary;
  jobs: DiscoveredJob[];
  counters: DiscoveryCounters;
  diagnostics: SourceDiagnostic[];
};

export type DiscoveryOptions = {
  asOf?: string;
  evaluate?: boolean;
  /** Maximum exact adverts to fetch and inspect in this wave. */
  maxResults?: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => string;
};

export type DiscoveryConnector = (
  repository: StorageRepository,
  workspace: WorkspaceSnapshot,
  options?: DiscoveryOptions,
) => Promise<DiscoveryBatch>;

export function emptyCounters(): DiscoveryCounters {
  return { searched: 0, detailed: 0, imported: 0, skipped: 0, failed: 0 };
}

export function isActionableDiscoveryJob(job: DiscoveredJob): boolean {
  const evaluation = job.evaluation;
  return job.actionable
    && evaluation !== undefined
    && evaluation.archetype !== "X"
    && evaluation.verdict !== "BLOCKED"
    && !evaluation.gates.some((gate) => gate.status === "BLOCKED");
}

export function discoveryJobNeedsReview(job: DiscoveredJob): boolean {
  return job.needs_review === true
    || evaluationNeedsReview(job.evaluation);
}

export function evaluationNeedsReview(evaluation: EvaluationResult | undefined): boolean {
  return evaluation === undefined
    || evaluation.archetype === "REVIEW"
    || evaluation.tier === "C"
    || evaluation.verdict === "VERIFY"
    || evaluation.gates.some((gate) => gate.status === "VERIFY");
}
