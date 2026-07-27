import { createHash } from "node:crypto";
import type { WorkspaceSnapshot } from "../../core/src/types";
import type { EvaluationInput, ProvenanceSnapshot, StoredJob } from "../../storage/src/repository";
import { classify, evaluationRules, gate, taxonomy } from "./rules";
import type { EvaluationResult, EvidenceMapping, ExtractedJob, Gate } from "./types";

type Verified<T> = { value: T | null; verification_status: string; provenance: Array<{ source_type: string; source_ref: string }> };
type Profile = {
  transport?: { driver_licence?: Verified<boolean>; has_car?: Verified<boolean> };
  languages?: { english?: Verified<{ self_assessed_level?: string }>; german?: Verified<{ self_assessed_level?: string }> };
  constraints?: { night_shifts?: Verified<string>; continuous_heavy_work?: Verified<string> };
  compensation?: { net_monthly_estimate?: Verified<{ floor_eur?: number }> };
};
type Evidence = {
  id: string;
  kind: string;
  statement: string;
  reviewer_status: string;
  provenance?: Array<{ source_type?: string; source_ref?: string }>;
};

function field(extracted: ExtractedJob, name: string): string | null {
  const value = extracted.fields[name];
  return value?.state === "known" ? value.value : null;
}

function verified<T>(value: Verified<T> | undefined): value is Verified<T> & { value: T } {
  return (value?.verification_status === "user_confirmed" || value?.verification_status === "document_verified") && value.value !== null && value.value !== undefined;
}

function levelAtLeast(actual: string | undefined, required: "B1" | "B2" | "C1" | "C2"): boolean {
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

function placeholder(text: string | null): boolean {
  return /^(?:tbd|unknown)$/i.test(text?.trim() ?? "");
}

function hasValidProvenance(record: Evidence): boolean {
  return record.provenance?.some((item) => item.source_type && item.source_ref) ?? false;
}

function explicitlyNoOwnCarRequired(text: string): boolean {
  return /\bno own car required\b|\b(?:own )?car (?:is )?not required\b/i.test(text);
}

function mandatoryOwnCarRequired(text: string): boolean {
  const withoutNegations = text.replace(/\bno own car required\b|\b(?:own )?car (?:is )?not required\b/gi, "");
  return /\bown car required\b/i.test(withoutNegations);
}

function mandatoryDrivingLicenceRequired(text: string): boolean {
  return textClauses(text).some((clause) => {
    const mentionsLicence = /\b(?:driving|driver'?s?) licen[cs]e(?: class)? b\b|\bführerschein(?:klasse)?\s*b\b/i.test(clause);
    const optional = /\b(?:optional|preferred|plus|nice to have|wünschens?wert|not required|nicht erforderlich)\b/i.test(clause);
    return mentionsLicence && !optional;
  });
}

function explicitlyNoNightWorkRequired(text: string): boolean {
  return /\bno night shifts?(?: are| is)? required\b|\bday shifts? only\b/i.test(text);
}

function mandatoryNightWorkRequired(text: string): boolean {
  return textClauses(text).some((clause) =>
    (/\b(?:night|rotating)(?:\s+or\s+(?:night|rotating))?\s+(?:shifts?|schedules?)\b|\b24\s*(?:[/x×]\s*)?7\b/i.test(clause))
    && !/\bno\s+(?:night|rotating)\s+(?:shifts?|schedules?)\b|\bday shifts? only\b|\b(?:night|rotating)\s+(?:shifts?|schedules?)\s+(?:optional|not required)\b/i.test(clause));
}

function calmNightWorkContext(text: string): boolean {
  return /\bmonitoring\b|\btickets?\b|\bNOC\b|\binternal IT\b|\bIT operations?\b|\btechnical operations?\b/i.test(text);
}

function explicitlyNoHeavyWorkRequired(text: string): boolean {
  return /\bno (?:continuous )?heavy (?:work|labou?r|lifting)(?: is)? required\b|\b(?:continuous )?heavy (?:work|labou?r|lifting) (?:is )?not required\b/i.test(text);
}

function mandatoryHeavyWorkRequired(text: string): boolean {
  const withoutNegations = text.replace(/\bno (?:continuous )?heavy (?:work|labou?r|lifting)(?: is)? required\b|\b(?:continuous )?heavy (?:work|labou?r|lifting) (?:is )?not required\b/gi, "");
  return /continuous heavy|heavy labour|heavy labor/i.test(withoutNegations);
}

/**
 * Disqualifying physical/work-style demands beyond "continuous heavy work":
 * prolonged standing, repeated heavy lifting, mass rack install/decommission as
 * the main duty, and constant field travel. These conflict with the verified
 * candidate constraint regardless of the heavy-work wording.
 */
function mandatoryDisqualifyingPhysical(text: string): { hit: boolean; reason: string } {
  const withoutNegations = text.replace(/\bno (?:prolonged standing|constant travel|mass rack(?:ing)?|repeated heavy lifting)(?: is)? required\b|\b(?:prolonged standing|constant travel|mass rack(?:ing)?|repeated heavy lifting) (?:is )?not required\b/gi, "");
  if (/\bprolonged standing\b|\bdauerhaft(?:e|en)?\s+stehende?\s+[-\s]?tätigkeit\b|\bdurchgehend\s+stehen\b/i.test(withoutNegations)) {
    return { hit: true, reason: "Prolonged standing conflicts with the verified physical constraint" };
  }
  if (/\brepeated heavy lifting\b|\bwiederholtes\s+schweres\s+heben\b/i.test(withoutNegations)) {
    return { hit: true, reason: "Repeated heavy lifting conflicts with the verified physical constraint" };
  }
  if (/\bmass rack(?:ing)?\b|\bmassenhaft(?:e|en)?\s+rack\b|\broutine\s+rack\s+(?:install|decommission)/i.test(withoutNegations)
    || /\b(?:rack|server)\s+(?:installation|decommission(?:ing)?)\s+(?:is\s+)?(?:the\s+)?main\b/i.test(withoutNegations)) {
    return { hit: true, reason: "Routine mass rack install/decommission as the main duty is outside scope" };
  }
  if (/\bconstant(?:ly)?\s+(?:field\s+)?travel\b|\bdauer(?:haft|nd)\s+(?:unterwegs|reisen)\b|\breiseintensiv\b/i.test(withoutNegations)) {
    return { hit: true, reason: "Constant field travel conflicts with the verified physical constraint" };
  }
  return { hit: false, reason: "" };
}

function explicitlyNoGermanRequirement(text: string): boolean {
  return /\bno german(?: language)?(?: is)? required\b|\bgerman(?: language)? (?:is )?not required\b|\b(?:german|deutsch(?:kenntnisse)?)(?:\s+(?:level|niveau)?\s*(?:a1|a2|b1|b2|c1|c2))?\s+(?:is\s+)?(?:a\s+)?(?:plus|preferred|optional|wünschens?wert|not required)\b/i.test(text);
}

function textClauses(text: string): string[] {
  return text
    .split(/[\n;]+|(?<=[.!?])\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/**
 * A CEFR-coded mandatory German requirement at B1 or above. For this candidate
 * (A2, not a German telephone helpdesk fit), any mandatory B1+ German is a
 * blocker unless an English alternative is explicitly accepted.
 */
function mandatoryCefrGermanRequirement(text: string): "B1" | "B2" | "C1" | "C2" | null {
  for (const clause of textClauses(text)) {
    const match =
      /(?:german|deutsch(?:kenntnisse)?)\s*(?:level|niveau)?\s*(b1|b2|c1|c2)\b/i.exec(clause)
      ?? /\b(?:required|mandatory|minimum|at least|mindestens|erforderlich|zwingend)\b[^,;\n]{0,30}\b(b1|b2|c1|c2)\s*(?:german|deutsch(?:kenntnisse)?)\b/i.exec(clause);
    if (!match) continue;
    const optional = /\b(?:optional|preferred|plus|nice to have|wünschens?wert|not required|nicht erforderlich)\b/i.test(clause);
    const mandatory = /\b(?:required|mandatory|minimum|at least|mindestens|erforderlich|zwingend|vorausgesetzt)\b/i.test(clause);
    if (optional && !mandatory) continue;
    return match[1].toUpperCase() as "B1" | "B2" | "C1" | "C2";
  }
  return null;
}

/**
 * Qualitative but binding German-fluency phrasing that has no CEFR tag but is
 * effectively B1+ or higher: "gute/sehr gute/fließe/verhandlungssichere
 * Deutschkenntnisse" required. Treated as at least B1.
 */
function mandatoryQualitativeGermanRequirement(text: string): boolean {
  return textClauses(text).some((clause) => {
    const qualitative = /(?:gute|sehr\s+gute|fließende|fließend|verhandlungssicher(?:e|en)?)\s+(?:deutsch|deutschkenntnisse|ken oversight in german)/i.test(clause);
    const optional = /\b(?:optional|preferred|plus|nice to have|wünschens?wert|not required|nicht erforderlich)\b/i.test(clause);
    const negated = /\b(?:no|not|keine)\b.{0,30}(?:gute|sehr\s+gute|fließende|fließend|verhandlungssicher)/i.test(clause);
    return qualitative && !optional && !negated;
  });
}

/**
 * German-language customer contact with no English alternative: telephone
 * helpdesk, Kundenservice am Telefon, 1st-level German phone support, etc.
 * Blocker for an A2 candidate who is not a German phone-support fit.
 */
function mandatoryGermanCustomerContact(text: string): boolean {
  if (/\benglish\s+(?:is\s+)?(?:accepted|allowed|sufficient|ok(?:ay)?)\s+(?:as\s+)?(?:an\s+)?alternative\b/i.test(text)) return false;
  return /(?:german[-\s]+(?:phone|telephone|kundenservice|kunden|customer|helpdesk|support))|(?:telefonisch.+deutsch)|(?:deutsch.+telefonisch)|(?:kundenservice.+am\s+telefon)|(?:regular\s+(?:customer|client)\s+communication[^.;\n]{0,30}\bin\s+german\b)|(?:regelmäßige\s+kundenkommunikation[^.;\n]{0,30}\b(?:auf\s+deutsch|deutschsprachig)\b)/i.test(text);
}

function reliableIsoDate(value: string | null): value is string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const [year, month, day] = (value ?? "").split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function hasAcceptedEnglishAlternative(languages: string | null, germanRequirement: "B1" | "B2" | "C1" | "C2"): boolean {
  const text = languages ?? "";
  return new RegExp(`german\\s+${germanRequirement}\\s*(?:required\\s*)?(?:or|/)\\s*english|english\\s*(?:or|/)\\s*german\\s+${germanRequirement}`, "i").test(text)
    || /\benglish\s+(?:is\s+)?(?:accepted|allowed|sufficient|ok(?:ay)?)\s+(?:as\s+)?(?:an\s+)?alternative\b/i.test(text);
}

function explicitNetMonthlyEur(salary: string | null): number | null {
  const match = /€\s*([\d.,]+)\s*net\s+per\s+month\b/i.exec(salary ?? "");
  const value = match?.[1];
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}$/.test(value)) return null;
  const amount = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(amount) ? amount : null;
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
  const nightWorkRequired = shift ? mandatoryNightWorkRequired(shift) : false;
  const gates: Record<string, Gate> = {
    archetype: archetype === "X" ? gate("archetype", "BLOCKED", true, "Role is outside the supported archetypes", ["taxonomy"])
      : gate("archetype", "PASS", true, `Classified as ${archetype}`, ["taxonomy"]),
    shift: !shift || placeholder(shift) ? gate("shift", "VERIFY", true, "Shift requirements are unknown")
      : nightWorkRequired && verified(profile.constraints?.night_shifts) && profile.constraints?.night_shifts.value === "blocked"
        ? gate("shift", "BLOCKED", true, "Posting requires night or rotating shifts", ["profile.constraints.night_shifts"])
        : nightWorkRequired && !verified(profile.constraints?.night_shifts) ? gate("shift", "VERIFY", true, "Night or rotating shifts conflict status is unknown")
          : nightWorkRequired && calmNightWorkContext(`${shift} ${skills ?? ""}`)
            ? gate("shift", "PASS_WITH_RISK", true, "Night work is mainly monitoring, tickets, NOC, or internal technical operations", ["profile.constraints.night_shifts"])
          : nightWorkRequired ? gate("shift", "VERIFY", true, "Night or rotating work is not clearly a calm technical operation")
          : explicitlyNoNightWorkRequired(shift) ? gate("shift", "PASS", true, "Posting explicitly excludes night work")
            : gate("shift", "PASS", true, "No night or rotating shift requirement"),
    transport: !car || placeholder(car) ? gate("transport", "VERIFY", true, "Transport requirements are unknown")
      : mandatoryOwnCarRequired(car) && verified(profile.transport?.has_car) && profile.transport?.has_car.value === false
          ? gate("transport", "BLOCKED", true, "Own car is required but verified unavailable", ["profile.transport.has_car"])
          : mandatoryOwnCarRequired(car) && verified(profile.transport?.has_car) && profile.transport?.has_car.value === true
            ? gate("transport", "PASS", true, "Verified own car meets the requirement", ["profile.transport.has_car"])
            : mandatoryOwnCarRequired(car) ? gate("transport", "VERIFY", true, "Own-car requirement needs verification")
              : mandatoryDrivingLicenceRequired(car) && verified(profile.transport?.driver_licence) && profile.transport.driver_licence.value === true
                ? gate("transport", "PASS", true, "Verified driving licence B meets the requirement", ["profile.transport.driver_licence"])
              : mandatoryDrivingLicenceRequired(car) && verified(profile.transport?.driver_licence) && profile.transport.driver_licence.value === false
                ? gate("transport", "BLOCKED", true, "Driving licence B is required but verified unavailable", ["profile.transport.driver_licence"])
              : mandatoryDrivingLicenceRequired(car) ? gate("transport", "VERIFY", true, "Driving licence B needs verification")
              : explicitlyNoOwnCarRequired(car) ? gate("transport", "PASS", false, "Posting explicitly states that no own car is required")
                : gate("transport", "VERIFY", true, "Transport requirement needs confirmation"),
    physical: (() => {
      const physicalText = `${physical ?? ""} ${skills ?? ""}`.trim();
      if (!physicalText || placeholder(physicalText)) return gate("physical", "VERIFY", true, "Physical requirements are unknown");
      const physicalConstraint = profile.constraints?.continuous_heavy_work;
      const blocksPhysicalWork = verified(physicalConstraint) && /blocked|avoid_continuous_heavy_work/i.test(physicalConstraint.value);
      if (mandatoryHeavyWorkRequired(physicalText) && blocksPhysicalWork) {
        return gate("physical", "BLOCKED", true, "Continuous heavy work conflicts with a verified constraint", ["profile.constraints.continuous_heavy_work"]);
      }
      if (mandatoryHeavyWorkRequired(physicalText)) return gate("physical", "VERIFY", true, "Physical requirement needs confirmation");
      const disqualifying = mandatoryDisqualifyingPhysical(physicalText);
      if (disqualifying.hit && blocksPhysicalWork) {
        return gate("physical", "BLOCKED", true, disqualifying.reason, ["profile.constraints.continuous_heavy_work"]);
      }
      if (disqualifying.hit) return gate("physical", "VERIFY", true, disqualifying.reason);
      if (explicitlyNoHeavyWorkRequired(physicalText)) return gate("physical", "PASS", false, "Posting explicitly states that continuous heavy work is not required");
      return gate("physical", "VERIFY", true, "Physical requirement needs confirmation");
    })(),
    scope: !skills || placeholder(skills) ? gate("scope", "VERIFY", true, "Role scope is unknown")
      : includes(skills, /warehouse|conveyor/i) ? gate("scope", "BLOCKED", true, "Warehouse or conveyor work is outside scope", ["posting.skills"])
        : /\bmass\s+rack(?:ing|ed)?\b|\broutine\s+rack\s+(?:install|decommission)/i.test(skills ?? "")
          ? gate("scope", "BLOCKED", true, "Routine mass rack install/decommission is outside scope", ["posting.skills"])
          : gate("scope", "PASS", false, "No warehouse or conveyor requirement"),
    facilities: includes(`${skills} ${education}`, /electrical|hvac|high-voltage|critical switching/i) && archetype !== "BT"
      ? gate("facilities", "BLOCKED", true, "Electrical or HVAC work requires unproven hands-on qualification", ["posting.skills", "posting.education"])
      : !skills || placeholder(skills) || !education || placeholder(education)
        ? gate("facilities", "VERIFY", true, "Facilities requirements are unknown")
        : gate("facilities", "PASS", false, "No unsupported electrical or HVAC requirement"),
    language: (() => {
      const languageText = `${languages ?? ""} ${skills ?? ""}`.trim();
      if (!languageText || placeholder(languageText)) return gate("language", "VERIFY", true, "Language requirements are unknown");
      const germanRequirement = mandatoryCefrGermanRequirement(languageText);
      const englishAlternative = germanRequirement !== null && hasAcceptedEnglishAlternative(languageText, germanRequirement);
      const qualitative = germanRequirement === null && mandatoryQualitativeGermanRequirement(languageText);
      const germanCustomerContact = mandatoryGermanCustomerContact(languageText);
      if (!germanRequirement && !qualitative && !germanCustomerContact) {
        return explicitlyNoGermanRequirement(languageText)
          ? gate("language", "PASS", false, "Posting explicitly has no mandatory German requirement")
          : gate("language", "VERIFY", true, "Language requirement needs confirmation");
      }
      const requiredLevel = germanRequirement ?? "B1";
      if (englishAlternative) {
        const german = profile.languages?.german;
        const english = profile.languages?.english;
        if (verified(german) && levelAtLeast(german.value.self_assessed_level, requiredLevel)) {
          return gate("language", "PASS", true, "German alternative is verified", ["profile.languages.german"]);
        }
        if (verified(english) && levelAtLeast(english.value.self_assessed_level, requiredLevel)) {
          return gate("language", "PASS", true, "English alternative is verified", ["profile.languages.english"]);
        }
        if (!verified(german) || !verified(english)) return gate("language", "VERIFY", true, "German or English alternative needs verification");
        return gate("language", "BLOCKED", true, "German and English alternatives conflict with verified levels", ["profile.languages.german", "profile.languages.english"]);
      }
      if (germanCustomerContact) {
        const german = profile.languages?.german;
        if (verified(german) && !levelAtLeast(german.value.self_assessed_level, "B2")) {
          return gate("language", "BLOCKED", true, "German customer/phone contact conflicts with verified level", ["profile.languages.german"]);
        }
        return gate("language", "VERIFY", true, "German customer/phone contact needs verification of fit", ["profile.languages.german"]);
      }
      const german = profile.languages?.german;
      if (verified(german) && !levelAtLeast(german.value.self_assessed_level, requiredLevel)) {
        return gate("language", "BLOCKED", true, `German ${requiredLevel} conflicts with verified level`, ["profile.languages.german"]);
      }
      if (verified(german)) {
        return gate("language", "PASS", true, `Verified German level meets ${requiredLevel}`, ["profile.languages.german"]);
      }
      return gate("language", "VERIFY", true, `German ${requiredLevel} needs verification`);
    })(),
    experience: !experience || placeholder(experience) ? gate("experience", "VERIFY", true, "Experience requirements are unknown")
      : includes(experience, /senior-only|senior.*required|[3-9]\s+years.*(senior|professional)/i)
        ? gate("experience", "BLOCKED", true, "Senior-only experience is required", ["posting.experience"])
        : gate("experience", "PASS", false, "No senior-only experience requirement"),
    salary: (() => {
      const amount = explicitNetMonthlyEur(salary);
      const floor = profile.compensation?.net_monthly_estimate;
      if (amount === null) return gate("salary", "VERIFY", false, "Salary is unknown or cannot be compared deterministically");
      if (!verified(floor) || typeof floor.value.floor_eur !== "number") {
        return gate("salary", "VERIFY", false, "Candidate salary floor needs verification");
      }
      if (amount < floor.value.floor_eur) {
        return gate("salary", "BLOCKED", true, "Explicit net salary is below the verified floor", ["profile.compensation.net_monthly_estimate"]);
      }
      return gate("salary", "PASS", false, "Explicit net salary meets the verified floor");
    })(),
    deadline: reliableIsoDate(deadline) && deadline < asOf
      ? gate("deadline", "BLOCKED", true, "Reliable application deadline has expired", ["posting.deadline"])
      : reliableIsoDate(deadline) ? gate("deadline", "PASS", false, "Deadline has not expired") : gate("deadline", "VERIFY", false, "Deadline is unknown or unreliable"),
  };
  return evaluationRules.gate_order.map((id) => gates[id]);
}

function mappingFor(requirement: ExtractedJob["requirements"][number], evidence: Evidence[]): EvidenceMapping {
  const text = requirement.text.toLowerCase();
  const id = `mapping_${requirement.id}`;
  const unknownClaim = /home[-\s]+lab|planned|theory/.test(text);
  const discord = evidence.find((record) => record.kind === "informal_assistance");
  const eligibleEvidence = evidence.filter((record) => record.kind !== "planned_project" && !/home[-\s]+lab|planned|theory/i.test(record.statement));
  const verifiedExact = eligibleEvidence.find((record) => record.kind !== "informal_assistance"
    && ["user_confirmed", "document_verified"].includes(record.reviewer_status)
    && hasValidProvenance(record)
    && record.statement.toLowerCase().includes(text));
  if (verifiedExact) {
    return { id, requirementId: requirement.id, status: "proven", evidenceIds: [verifiedExact.id], credit: evaluationRules.mapping_credits.proven };
  }
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
  const requirementStorageIds = new Map(extracted.requirements.map((requirement) => [
    requirement.id,
    derivedId("requirement", `${result.fingerprint}:${requirement.id}`),
  ]));
  return {
    id,
    jobId: result.jobId,
    runKey: `evaluation:${result.fingerprint}`,
    semanticFingerprint: result.fingerprint,
    evaluatorVersion: `${evaluationRules.evaluator_version}/${taxonomy.version}/${evaluationRules.version}`,
    provenance,
    requirements: extracted.requirements.map((requirement) => ({
      id: requirementStorageIds.get(requirement.id) as string,
      domain_id: requirement.id,
      type: requirement.type,
      text: requirement.text,
      rule_ids: requirement.rule_ids,
    })),
    evidenceMappings: result.mappings.map((mapping) => ({
      id: derivedId("mapping", `${result.fingerprint}:${mapping.id}`),
      domainId: mapping.id,
      requirementId: requirementStorageIds.get(mapping.requirementId) as string,
      domainRequirementId: mapping.requirementId,
      evidenceIds: mapping.evidenceIds,
      evidenceSnapshotHash,
      provenance,
      mappingStatus: mapping.status,
      credit: mapping.credit,
    })),
    gateResults: result.gates.map((item) => ({ ...item, id: derivedId("gate", `${result.fingerprint}:${item.id}`), domain_id: item.id })),
    fitScores: [{ id: derivedId("fit", result.fingerprint), score: result.fit, mapping_credits: result.mappings.map((mapping) => ({ requirement_id: mapping.requirementId, credit: mapping.credit })) }],
    survivalScores: [{ id: derivedId("survival", result.fingerprint), score: result.survival }],
    applicationTiers: [{ id: derivedId("tier", result.fingerprint), tier: result.tier, confidence: result.confidence }],
    recommendations: [{ id: derivedId("recommendation", result.fingerprint), verdict: result.verdict, blocked: result.gates.some((item) => item.status === "BLOCKED") }],
  };
}
