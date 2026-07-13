type Record_ = { id: string; kind: string; statement: string; reviewer_status: string };
type Mapping = { status: string; evidenceIds: string[] };
type Gate = { status: string; reason: string; critical?: boolean };
type VerifiedField = {
  value?: string | null;
  verification_status?: string;
  provenance?: Array<{ source_type?: string; source_ref?: string }>;
};

function verifiedFactValue(field: VerifiedField | undefined): string | null {
  if (!field?.value) return null;
  if (!["user_confirmed", "document_verified"].includes(field.verification_status ?? "")) return null;
  if (!field.provenance?.some((item) => item.source_type && item.source_ref)) return null;
  return field.value;
}

export type DocumentPacket = { ready_for_submission: boolean; missing: string[]; english: string; german: string };

export function generateDocumentPacket(input: { title: string; company: string; evaluation: { mappings: Mapping[]; gates: Gate[]; verdict?: string; tier?: string }; workspace: { profile: Record<string, unknown>; evidence: { records: Record_[] } } }): DocumentPacket {
  const identity = input.workspace.profile.identity as { name?: VerifiedField; email?: VerifiedField; phone?: VerifiedField } | undefined;
  const missing = ["name", "email", "phone"].filter((key) => !verifiedFactValue(identity?.[key as keyof typeof identity])).map((key) => `profile.identity.${key}`);
  const allowedIds = new Set(input.evaluation.mappings.filter((mapping) => ["proven", "partial", "transferable"].includes(mapping.status)).flatMap((mapping) => mapping.evidenceIds));
  const evidence = input.workspace.evidence.records.filter((record) => allowedIds.has(record.id)
    && ["user_confirmed", "document_verified"].includes(record.reviewer_status)
    && record.kind !== "planned_project" && record.kind !== "informal_assistance");
  const verify = input.evaluation.gates.filter((gate) => gate.status === "VERIFY").map((gate) => gate.reason);
  if (evidence.length === 0) missing.push("evidence.mapped_role_evidence");
  if (input.evaluation.verdict === "BLOCKED" || input.evaluation.tier === "C") missing.push("evaluation.non_blocked_match");
  if (input.evaluation.gates.some((gate) => gate.status === "VERIFY" && gate.critical)) missing.push("evaluation.critical_conditions_verified");
  const evidenceEn = evidence.length ? evidence.map((record) => `- ${record.statement} [${record.id}]`).join("\n") : "- No verified role-specific evidence mapped yet.";
  const evidenceDe = evidence.length ? evidence.map((record) => `- ${record.statement} [${record.id}]`).join("\n") : "- Noch keine verifizierten rollenspezifischen Nachweise zugeordnet.";
  return {
    ready_for_submission: missing.length === 0,
    missing,
    english: `# CV draft — ${input.title}\n\nTarget company: ${input.company}\n\n## Evidence-backed capabilities\n${evidenceEn}\n\n## Verify before application\n${verify.map((item) => `- ${item}`).join("\n") || "- None recorded."}\n\n# Cover letter draft\nI am interested in the ${input.title} position at ${input.company}. My relevant claims are limited to the evidence listed above.`,
    german: `# Lebenslauf-Entwurf — ${input.title}\n\nZielunternehmen: ${input.company}\n\n## Nachweisbare Kompetenzen\n${evidenceDe}\n\n## Vor der Bewerbung prüfen\n${verify.map((item) => `- ${item}`).join("\n") || "- Keine offenen Punkte erfasst."}\n\n# Anschreiben-Entwurf\nIch interessiere mich für die Position ${input.title} bei ${input.company}. Meine relevanten Angaben beschränken sich auf die oben aufgeführten Nachweise.`,
  };
}
