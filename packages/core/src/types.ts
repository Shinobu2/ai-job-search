export type VerificationStatus =
  | "unknown"
  | "user_confirmed"
  | "document_verified"
  | "rejected"
  | "expired";

export interface ProvenanceRef {
  source_type: "user_statement" | "document" | "system";
  source_ref: string;
}

export interface VerifiedValue<T> {
  value: T | null;
  verification_status: VerificationStatus;
  provenance: ProvenanceRef[];
}

export interface WorkspaceSnapshot {
  profile: unknown;
  evidence: unknown;
  "document-pack": unknown;
  search: unknown;
  "auto-apply": unknown;
}
