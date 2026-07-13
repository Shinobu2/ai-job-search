import type { WorkspaceSnapshot } from "../../core/src/types";
import type { EvaluationResult } from "../../jobs/src/types";
import type { StorageRepository } from "../../storage/src/repository";

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
  actionable: boolean;
  evaluation?: EvaluationResult;
};

export type DiscoveryBatch = {
  sourceId: string;
  status: DiscoveryStatus;
  scope: DiscoveryScopeSummary;
  jobs: DiscoveredJob[];
  counters: DiscoveryCounters;
  diagnostics: SourceDiagnostic[];
};

export type DiscoveryOptions = {
  asOf?: string;
  evaluate?: boolean;
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
