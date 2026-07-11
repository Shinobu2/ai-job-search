import { createHash } from "node:crypto";
import type { WorkspaceSnapshot } from "../../core/src/types";
import type { EvaluationInput, ProvenanceSnapshot, StoredJob } from "../../storage/src/repository";
import { classify, evaluationRules, gate, taxonomy } from "./rules";
import type { EvaluationResult, EvidenceMapping, ExtractedJob, Gate } from "./types";

type Verified<T> = { value: T | null; verification_status: string; provenance: Array<{ source_type: string; source_ref: string }> };
type Profile = {
  transport?: { has_car?: Verified<boolean> };
  languages?: { english?: Verified<{ self_assessed_level?: string }>; german?: Verified<{ self_assessed_level?: string }> };
  constraints?: { night_shifts?: Verified<string>; continuous_heavy_work?: Verified<string> };
  compensation?: { net_monthly_estimate?: Verified<{ floor_eur?: number }> };
};
type Evidence = { id: string; kind: string; statement: string; reviewer_status: string };

function field(extracted: ExtractedJob, name: string): string | null {
  const value = extracted.fields[name];
  return value?.state === "known" ? value.value : null;
}

function verified<T>(value: Verified<T> | undefined): value is Verified<T> & { value: T } {
  return (value?.verification_status === "user_confirmed" || value?.verification_status === "document_verified") && value.value !== null && value.value !== undefined;
}

function levelAtLeast(actual: string | undefined, required: "B2" | "C1"): boolean {
  return ["A1", "A2", "B1", "B2", "C1", "C2"].indexOf(actual ?? "") >= ["A1", "A2", "B1", "B2", "C1", "C2"].indexOf(required);
}

function profileOf(workspace: WorkspaceSnapshot): Profile {
  return workspace.profile as Profile;
}

function evidenceOf(workspace: WorkspaceSnapshot): Evidence[] {
  const evidence = workspace.evidence as { records?: Evidence[] };
  return evidence.records ?? [];
}

function includes(text: string | null, pattern: RegExp): boolean {
  return pattern.test(text ?? "");
}

function hasAcceptedEnglishAlternative(languages: string | null, germanRequirement: "B2" | "C1"): boolean {
  const text = languages ?? "";
  return new RegExp(`german\\s+${germanRequirement}\\s*(?:required\\s*)?(?:or|/)\\s*english|english\\s*(?:or|/)\\s*german\\s+${germanRequirement}`, "i").test(text)
    || /\benglish\s+(?:is\s+)?(?:accepted|allowed|sufficient|ok(?:ay)?)\s+(?:as\s+)?(?:an\s+)?alternative\b/i.test(text);
}

function gatesFor(archetype: EvaluationResult["archetype"], extracted: ExtractedJob, workspace: WorkspaceSnapshot, asOf: string): Gate[] {
  const profile = profileOf(workspace);
  const shift = field(extracted, "shift");
  const car = field(extracted, "car");
  const physical = field(extracted, "physical_requirements");
  const skills = field(extracted, "skills");
  const education = field(extracted, "education");
  const languages = field(extracted, "languages");
  const experience = field(extracted, "experience");
  const salary = field(extracted, "salary");
  const deadline = field(extracted, "deadline");
  const gates: Record<string, Gate> = {
    archetype: archetype === "X" ? gate("archetype", "BLOCKED", true, "Role is outside the supported archetypes", ["taxonomy"])
      : gate("archetype", "PASS", true, `Classified as ${archetype}`, ["taxonomy"]),
    shift: !shift ? gate("shift", "VERIFY", true, "Shift requirements are unknown")
      : includes(shift, /night|rotating/i) && verified(profile.constraints?.night_shifts) && profile.constraints?.night_shifts.value === "blocked"
        ? gate("shift", "BLOCKED", true, "Posting requires night or rotating shifts", ["profile.constraints.night_shifts"])
        : includes(shift, /night|rotating/i) ? gate("shift", "PASS_WITH_RISK", true, "Night or rotating shifts need confirmation")
          : gate("shift", "PASS", true, "No night or rotating shift requirement"),
    transport: includes(car, /own car required/i) && verified(profile.transport?.has_car) && profile.transport?.has_car.value === false
      ? gate("transport", "BLOCKED", true, "Own car is required but verified unavailable", ["profile.transport.has_car"])
      : includes(car, /own car required/i) && verified(profile.transport?.has_car) && profile.transport?.has_car.value === true
        ? gate("transport", "PASS", true, "Verified own car meets the requirement", ["profile.transport.has_car"])
        : includes(car, /own car required/i) ? gate("transport", "VERIFY", true, "Own-car requirement needs verification")
        : gate("transport", "PASS", false, "No own-car requirement"),
    physical: includes(physical, /continuous heavy|heavy labour|heavy labor/i) && verified(profile.constraints?.continuous_heavy_work) && profile.constraints?.continuous_heavy_work.value === "blocked"
      ? gate("physical", "BLOCKED", true, "Continuous heavy work conflicts with a verified constraint", ["profile.constraints.continuous_heavy_work"])
      : includes(physical, /continuous heavy|heavy labour|heavy labor/i) ? gate("physical", "VERIFY", true, "Physical requirement needs confirmation")
        : gate("physical", "PASS", false, "No continuous heavy-work requirement"),
    scope: includes(skills, /warehouse|conveyor/i) ? gate("scope", "BLOCKED", true, "Warehouse or conveyor work is outside scope", ["posting.skills"])
      : gate("scope", "PASS", false, "No warehouse or conveyor requirement"),
    facilities: includes(`${skills} ${education}`, /electrical|hvac|high-voltage|critical switching/i) && archetype !== "BT"
      ? gate("facilities", "BLOCKED", true, "Electrical or HVAC work requires unproven hands-on qualification", ["posting.skills", "posting.education"])
      : gate("facilities", "PASS", false, "No unsupported electrical or HVAC requirement"),
    language: (() => {
      const germanRequirement = /german\s+(b2|c1)/i.exec(languages ?? "")?.[1]?.toUpperCase() as "B2" | "C1" | undefined;
      const englishAlternative = germanRequirement !== undefined && hasAcceptedEnglishAlternative(languages, germanRequirement);
      if (!germanRequirement) return gate("language", "PASS", false, "No German B2/C1 requirement");
      if (englishAlternative) {
        const german = profile.languages?.german;
        const english = profile.languages?.english;
        if (verified(german) && levelAtLeast(german.value.self_assessed_level, germanRequirement)) {
          return gate("language", "PASS", true, "German alternative is verified", ["profile.languages.german"]);
        }
        if (verified(english) && levelAtLeast(english.value.self_assessed_level, germanRequirement)) {
          return gate("language", "PASS", true, "English alternative is verified", ["profile.languages.english"]);
        }
        if (!verified(german) || !verified(english)) return gate("language", "VERIFY", true, "German or English alternative needs verification");
        return gate("language", "BLOCKED", true, "German and English alternatives conflict with verified levels", ["profile.languages.german", "profile.languages.english"]);
      }
      const german = profile.languages?.german;
      if (verified(german) && !levelAtLeast(german.value.self_assessed_level, germanRequirement)) {
        return gate("language", "BLOCKED", true, `German ${germanRequirement} conflicts with verified level`, ["profile.languages.german"]);
      }
      if (verified(german)) {
        return gate("language", "PASS", true, `Verified German level meets ${germanRequirement}`, ["profile.languages.german"]);
      }
      return gate("language", "VERIFY", true, `German ${germanRequirement} needs verification`);
    })(),
    experience: includes(experience, /senior-only|senior.*required|[3-9]\s+years.*(senior|professional)/i)
      ? gate("experience", "BLOCKED", true, "Senior-only experience is required", ["posting.experience"])
      : gate("experience", "PASS", false, "No senior-only experience requirement"),
    salary: (() => {
      const match = /€\s*([\d.,]+)\s*net\s+per\s+month/i.exec(salary ?? "");
      const amount = match ? Number(match[1].replace(/[.,]/g, "")) : null;
      const floor = profile.compensation?.net_monthly_estimate;
      if (amount !== null && verified(floor) && typeof floor.value.floor_eur === "number" && amount < floor.value.floor_eur) {
        return gate("salary", "BLOCKED", true, "Explicit net salary is below the verified floor", ["profile.compensation.net_monthly_estimate"]);
      }
      return amount === null ? gate("salary", "VERIFY", false, "Salary is unknown or cannot be compared deterministically") : gate("salary", "PASS", false, "Explicit net salary meets the verified floor");
    })(),
    deadline: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) && deadline < asOf
      ? gate("deadline", "BLOCKED", true, "Reliable application deadline has expired", ["posting.deadline"])
      : deadline ? gate("deadline", "PASS", false, "Deadline has not expired") : gate("deadline", "VERIFY", false, "Deadline is unknown"),
  };
  return evaluationRules.gate_order.map((id) => gates[id]);
}

function mappingFor(requirement: ExtractedJob["requirements"][number], evidence: Evidence[]): EvidenceMapping {
  const text = requirement.text.toLowerCase();
  const id = `mapping_${requirement.id}`;
  const unknownClaim = /home[-\s]+lab|planned|theory/.test(text);
  const discord = evidence.find((record) => record.kind === "informal_assistance");
  const eligibleEvidence = evidence.filter((record) => record.kind !== "planned_project" && !/home[-\s]+lab|planned|theory/i.test(record.statement));
  if (/support|help.?desk|ticket/.test(text) && discord) return { id, requirementId: requirement.id, status: "contradicted", evidenceIds: [], credit: evaluationRules.mapping_credits.contradicted };
  if (unknownClaim) return { id, requirementId: requirement.id, status: "unknown", evidenceIds: [], credit: evaluationRules.mapping_credits.unknown };
  if (/education|ausbildung|degree/.test(text)) return { id, requirementId: requirement.id, status: "missing", evidenceIds: [], credit: evaluationRules.mapping_credits.missing };
  const disqualified = evidence.find((record) => (record.kind === "planned_project" || /home[-\s]+lab|planned|theory/i.test(record.statement))
    && (record.statement.toLowerCase().includes(text) || (record.kind === "hardware" && /hardware|server|cabl/.test(text))));
  if (disqualified) return { id, requirementId: requirement.id, status: "unknown", evidenceIds: [], credit: evaluationRules.mapping_credits.unknown };
  const exact = eligibleEvidence.find((record) => record.statement.toLowerCase().includes(text));
  if (exact) {
    return { id, requirementId: requirement.id, status: "partial", evidenceIds: [exact.id], credit: evaluationRules.mapping_credits.partial };
  }
  const transferable = eligibleEvidence.find((record) => record.kind === "hardware" && /hardware|server|cabl/.test(text));
  if (transferable) return { id, requirementId: requirement.id, status: "transferable", evidenceIds: [transferable.id], credit: evaluationRules.mapping_credits.transferable };
  return { id, requirementId: requirement.id, status: "missing", evidenceIds: [], credit: evaluationRules.mapping_credits.missing };
}

function survivalFor(gates: Gate[]): number | null {
  const relevant = gates.filter((item) => item.facts.some((fact) => fact.startsWith("profile.")));
  if (relevant.length === 0) return null;
  return Math.round(relevant.reduce((total, item) => total + (item.status === "PASS" ? 100 : item.status === "PASS_WITH_RISK" ? 50 : 0), 0) / relevant.length);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function evaluateVacancy(job: StoredJob, extracted: ExtractedJob, workspace: WorkspaceSnapshot, asOf: string): EvaluationResult {
  const archetype = classify(extracted);
  const gates = gatesFor(archetype, extracted, workspace, asOf);
  const mappings = extracted.requirements.map((requirement) => mappingFor(requirement, evidenceOf(workspace)));
  const totalWeight = mappings.length * evaluationRules.requirement_weight;
  const fit = totalWeight === 0 ? 0 : Math.round(mappings.reduce((total, mapping) => total + mapping.credit * evaluationRules.requirement_weight, 0) / totalWeight);
  const survival = survivalFor(gates);
  const criticalVerify = gates.some((item) => item.critical && item.status === "VERIFY");
  const blocked = gates.some((item) => item.status === "BLOCKED");
  const verifies = gates.filter((item) => item.status === "VERIFY").length;
  const confidence: EvaluationResult["confidence"] = verifies === 0 ? "high" : verifies <= 2 ? "medium" : "low";
  let tier: EvaluationResult["tier"] = fit >= evaluationRules.tier_bands.S ? "S" : fit >= evaluationRules.tier_bands.A ? "A" : fit >= evaluationRules.tier_bands.B ? "B" : "C";
  if (criticalVerify && (tier === "S" || tier === "A")) tier = "B";
  if (blocked || archetype === "X") tier = "C";
  const verdict = blocked ? "BLOCKED" : criticalVerify ? "VERIFY" : "PROCEED";
  const resultWithoutFingerprint = { jobId: job.id, archetype, gates, mappings, fit, survival, confidence, tier, verdict };
  return { ...resultWithoutFingerprint, fingerprint: fingerprint({ taxonomy: taxonomy.version, rules: evaluationRules.version, extracted, workspace, asOf, resultWithoutFingerprint }) };
}

function derivedId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function buildEvaluationInput(result: EvaluationResult, extracted: ExtractedJob, workspace: WorkspaceSnapshot): EvaluationInput {
  const provenance: ProvenanceSnapshot[] = [
    { source_type: "system", source_ref: `config/role-taxonomy.json#${taxonomy.version}` },
    { source_type: "system", source_ref: `config/evaluation-rules.json#${evaluationRules.version}` },
  ];
  const evidenceSnapshotHash = fingerprint(workspace.evidence);
  const id = derivedId("evaluation", result.fingerprint);
  return {
    id,
    jobId: result.jobId,
    runKey: `evaluation:${result.fingerprint}`,
    semanticFingerprint: result.fingerprint,
    evaluatorVersion: `${evaluationRules.evaluator_version}/${taxonomy.version}/${evaluationRules.version}`,
    provenance,
    requirements: extracted.requirements.map((requirement) => ({ id: requirement.id, type: requirement.type, text: requirement.text, rule_ids: requirement.rule_ids })),
    evidenceMappings: result.mappings.map((mapping) => ({
      id: mapping.id,
      requirementId: mapping.requirementId,
      evidenceIds: mapping.evidenceIds,
      evidenceSnapshotHash,
      provenance,
      mappingStatus: mapping.status,
      credit: mapping.credit,
    })),
    gateResults: result.gates.map((item) => ({ ...item, id: derivedId("gate", `${result.fingerprint}:${item.id}`) })),
    fitScores: [{ id: derivedId("fit", result.fingerprint), score: result.fit, mapping_credits: result.mappings.map((mapping) => ({ requirement_id: mapping.requirementId, credit: mapping.credit })) }],
    survivalScores: [{ id: derivedId("survival", result.fingerprint), score: result.survival }],
    applicationTiers: [{ id: derivedId("tier", result.fingerprint), tier: result.tier, confidence: result.confidence }],
    recommendations: [{ id: derivedId("recommendation", result.fingerprint), verdict: result.verdict, blocked: result.gates.some((item) => item.status === "BLOCKED") }],
  };
}
