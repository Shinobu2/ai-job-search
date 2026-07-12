import type { EvaluationResult } from "./types";

type DisplayResult = EvaluationResult & { title?: string | null; company?: string | null };

function list(items: string[], empty: string): string {
  return items.length === 0 ? `- ${empty}` : items.map((item) => `- ${item}`).join("\n");
}

export function renderResultCard(result: EvaluationResult): string {
  const display = result as DisplayResult;
  const strongMatches = result.mappings
    .filter((mapping) => ["proven", "partial", "transferable"].includes(mapping.status))
    .map((mapping) => `${mapping.requirementId} (${mapping.status}; evidence: ${mapping.evidenceIds.join(", ") || "none"})`);
  const gaps = result.mappings
    .filter((mapping) => ["missing", "unknown", "contradicted"].includes(mapping.status))
    .map((mapping) => `${mapping.requirementId} (${mapping.status})`);
  const verifies = result.gates.filter((gate) => gate.status === "VERIFY").map((gate) => gate.reason);
  const nextAction = result.verdict === "BLOCKED" ? "Do not apply; record the blocker if the posting changes."
    : verifies.length > 0 ? "Verify the listed conditions before applying."
      : "Prepare the application using the cited evidence only.";
  const heading = [display.title ?? "Untitled role", display.company].filter(Boolean).join(" — ");

  return [
    "Job evaluation",
    heading || `Job: ${result.jobId}`,
    `Archetype: ${result.archetype}`,
    `Fit: ${result.fit}`,
    `Survival: ${result.survival ?? "unknown"}`,
    `Tier: ${result.tier}`,
    `Confidence: ${result.confidence}`,
    `Verdict: ${result.verdict}`,
    "Strong matches:",
    list(strongMatches, "No verified or transferable matches."),
    "Gaps:",
    list(gaps, "No material gaps recorded."),
    "VERIFY:",
    list(verifies, "None."),
    `Next action: ${nextAction}`,
  ].join("\n");
}
