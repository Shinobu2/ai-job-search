export type ImportRequest = {
  text?: string;
  file?: string;
  sourceUrl?: string;
  sourceId?: string;
  sourceType?: string;
};

export type ImportedJob = {
  id: string;
  reused: boolean;
  sourceHash: string;
  logicalVacancyId: string;
  version: number;
  title: string | null;
  company: string | null;
  location: string | null;
};

export type ExtractionState = "known" | "unknown" | "conflicting";

export type ExtractedField = {
  state: ExtractionState;
  value: string | null;
  spans: Array<{ start: number; end: number }>;
  rule_ids: string[];
};

export type ExtractedRequirement = {
  id: string;
  type: string;
  text: string;
  spans: Array<{ start: number; end: number }>;
  rule_ids: string[];
};

export type ExtractedJob = {
  version: "extraction-v1";
  fields: Record<string, ExtractedField>;
  requirements: ExtractedRequirement[];
  uncertainties: string[];
};

export type GateStatus = "PASS" | "PASS_WITH_RISK" | "VERIFY" | "BLOCKED" | "EMERGENCY_ONLY";

export type Gate = {
  id: string;
  status: GateStatus;
  critical: boolean;
  reason: string;
  facts: string[];
};

export type EvidenceMappingStatus = "proven" | "partial" | "transferable" | "missing" | "unknown" | "contradicted";

export type EvidenceMapping = {
  id: string;
  requirementId: string;
  status: EvidenceMappingStatus;
  evidenceIds: string[];
  credit: number;
};

export type EvaluationResult = {
  jobId: string;
  archetype: "A" | "AT" | "BT" | "F" | "X";
  gates: Gate[];
  mappings: EvidenceMapping[];
  fit: number;
  survival: number | null;
  confidence: "low" | "medium" | "high";
  tier: "S" | "A" | "B" | "C";
  verdict: string;
  fingerprint: string;
};
