export type ImportRequest = {
  text?: string;
  file?: string;
  sourceUrl?: string;
  sourceId?: string;
};

export type ImportedJob = {
  id: string;
  reused: boolean;
  sourceHash: string;
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
