import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSnapshot } from "../../packages/core/src/types";
import { validateWorkspaceFile } from "../../packages/core/src/workspace";
import { extractVacancy } from "../../packages/jobs/src/extract";
import { buildEvaluationInput, evaluateVacancy } from "../../packages/jobs/src/evaluate";
import type { ExtractedJob } from "../../packages/jobs/src/types";
import type { StoredJob } from "../../packages/storage/src/repository";

const fixtureDirectory = join(import.meta.dir, "../fixtures/jobs");

const workspace = {
  profile: {
    transport: { has_car: { value: false, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] } },
    languages: {
      english: { value: { self_assessed_level: "B2" }, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
      german: { value: { self_assessed_level: "A2" }, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
    },
    constraints: {
      night_shifts: { value: "blocked", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
      continuous_heavy_work: { value: "blocked", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
    },
    compensation: { net_monthly_estimate: { value: { floor_eur: 1750, target_eur: 2000 }, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] } },
  },
  evidence: { records: [] },
  "document-pack": {},
  search: {},
  "auto-apply": {},
} as unknown as WorkspaceSnapshot;

async function evaluateFixture(name: string) {
  const text = await readFile(join(fixtureDirectory, name), "utf8");
  const extracted = extractVacancy(text);
  const job: StoredJob = { id: `job_${name}`, title: extracted.fields.title.value, company: extracted.fields.company.value, location: extracted.fields.location.value };
  return evaluateVacancy(job, extracted, workspace, "2026-07-12");
}

test("classifies trainee, hardware, facilities, excluded facilities, and support roles in precedence order", async () => {
  expect((await evaluateFixture("dct-trainee.md")).archetype).toBe("AT");
  expect((await evaluateFixture("a-hardware-dct.md")).archetype).toBe("A");
  expect((await evaluateFixture("bt-facilities-trainee.md")).archetype).toBe("BT");
  expect((await evaluateFixture("unqualified-facilities.md")).archetype).toBe("X");
  expect((await evaluateFixture("f-it-support.md")).archetype).toBe("F");
});

test("classifies German service desk titles and does not assume 24/7 rotations are night-free", async () => {
  const result = await evaluateText("# Service Desk Agent im 24/7 Schichtdienst (w/m/d)\nCompany: maincubes\nLocation: Frankfurt am Main");
  expect(result.archetype).toBe("F");
  expect(result.gates).toContainEqual(expect.objectContaining({ id: "shift", status: "BLOCKED" }));
});

test("blocks mandatory and rotating nights using the verified candidate constraint", async () => {
  const mandatory = await evaluateFixture("night-shift.md");
  const rotating = await evaluateFixture("dct-trainee.md");
  expect(mandatory.gates).toContainEqual(expect.objectContaining({ id: "shift", status: "BLOCKED" }));
  expect(rotating.gates).toContainEqual(expect.objectContaining({ id: "shift", status: "BLOCKED" }));
});

test("blocks reliable role requirements that contradict verified candidate facts", async () => {
  const car = await evaluateFixture("own-car.md");
  const german = await evaluateFixture("german-b2.md");
  const heavy = await evaluateText("# Hardware Technician\nPhysical: Continuous heavy lifting required\nSkills: PC hardware");
  const warehouse = await evaluateText("# Hardware Technician\nSkills: Warehouse conveyor operation\n");
  const electrical = await evaluateText("# Electrical Technician\nSkills: HVAC, electrical switching\nEducation: Licensed electrician required\n");
  const senior = await evaluateText("# Hardware Technician\nExperience: 5 years senior-only professional experience required\n");
  const salary = await evaluateText("# Hardware Technician\nSalary: €1.200,00 net per month\n");
  const expired = await evaluateText("# Hardware Technician\nDeadline: 2026-07-01\n");
  for (const result of [car, german, heavy, warehouse, electrical, senior, salary, expired]) {
    expect(result.gates.some((gate) => gate.status === "BLOCKED")).toBe(true);
    expect(result.tier).toBe("C");
  }
});

test("keeps ambiguous net monthly salary separators VERIFY rather than guessing", async () => {
  const result = await evaluateText("# Hardware Technician\nSalary: €1,200 net per month\n");

  expect(result.gates).toContainEqual(expect.objectContaining({
    id: "salary",
    status: "VERIFY",
    reason: "Salary is unknown or cannot be compared deterministically",
  }));
});

test("ignores rejected, expired, and unknown profile values when evaluating gates", async () => {
  const text = await readFile(join(fixtureDirectory, "own-car.md"), "utf8");
  const extracted = extractVacancy(text);
  for (const verification_status of ["rejected", "expired", "unknown"]) {
    const result = evaluateVacancy({ id: `car_${verification_status}`, title: extracted.fields.title.value, company: null, location: null }, extracted, {
      ...workspace,
      profile: {
        ...(workspace.profile as object),
        transport: { has_car: { value: false, verification_status, provenance: [{ source_type: "user_statement", source_ref: "test" }] } },
      },
    }, "2026-07-12");
    expect(result.gates).toContainEqual(expect.objectContaining({ id: "transport", status: "VERIFY" }));
  }
});

test("keeps a comparable net salary VERIFY without a verified candidate floor", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSalary: €2.000,00 net per month\n");
  for (const net_monthly_estimate of [
    { value: {}, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
    { value: { floor_eur: 1750 }, verification_status: "unknown", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
  ]) {
    const result = evaluateVacancy({ id: "salary_unverified_floor", title: null, company: null, location: null }, extracted, {
      ...workspace,
      profile: {
        ...(workspace.profile as object),
        compensation: { net_monthly_estimate },
      },
    }, "2026-07-12");

    expect(result.gates).toContainEqual(expect.objectContaining({ id: "salary", status: "VERIFY", reason: "Candidate salary floor needs verification" }));
  }
});

test("blocks insufficient German when English is not explicitly accepted as an alternative", async () => {
  for (const languages of ["German B2 required; english not accepted", "German B2 required; english preferred"]) {
    const result = await evaluateText(`# Hardware Technician\nSkills: PC hardware\nLanguages: ${languages}\n`);
    expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "BLOCKED" }));
  }
});

test("treats English accepted in addition to German as an additive requirement", async () => {
  const result = await evaluateText("# Hardware Technician\nSkills: PC hardware\nLanguages: German B2 required; English is accepted in addition\n");
  expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "BLOCKED" }));
});

test("requires current verified English when it is an explicit German alternative", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\nLanguages: German B2 required or English\n");
  const result = evaluateVacancy({ id: "english_alternative_missing", title: null, company: null, location: null }, extracted, {
    ...workspace,
    profile: {
      ...(workspace.profile as object),
      languages: { german: (workspace.profile as { languages: { german: unknown } }).languages.german },
    },
  }, "2026-07-12");

  expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "VERIFY", critical: true }));
});

test("blocks a verified insufficient English alternative", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\nLanguages: German B2 required or English\n");
  const result = evaluateVacancy({ id: "english_alternative_insufficient", title: null, company: null, location: null }, extracted, {
    ...workspace,
    profile: {
      ...(workspace.profile as object),
      languages: {
        german: (workspace.profile as { languages: { german: unknown } }).languages.german,
        english: { value: { self_assessed_level: "A2" }, verification_status: "document_verified", provenance: [{ source_type: "document", source_ref: "test" }] },
      },
    },
  }, "2026-07-12");

  expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "BLOCKED", critical: true, facts: ["profile.languages.german", "profile.languages.english"] }));
});

test("passes a sufficient current verified English alternative", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\nLanguages: German B2 required or English\n");
  const result = evaluateVacancy({ id: "english_alternative_sufficient", title: null, company: null, location: null }, extracted, {
    ...workspace,
    profile: {
      ...(workspace.profile as object),
      languages: {
        german: (workspace.profile as { languages: { german: unknown } }).languages.german,
        english: { value: { self_assessed_level: "B2" }, verification_status: "document_verified", provenance: [{ source_type: "document", source_ref: "test" }] },
      },
    },
  }, "2026-07-12");

  expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "PASS", critical: true, facts: ["profile.languages.english"] }));
});

test("passes a sufficient verified German alternative when English is absent", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\nLanguages: German B2 required or English\n");
  const result = evaluateVacancy({ id: "german_alternative_sufficient", title: null, company: null, location: null }, extracted, {
    ...workspace,
    profile: {
      ...(workspace.profile as object),
      languages: {
        german: { value: { self_assessed_level: "B2" }, verification_status: "document_verified", provenance: [{ source_type: "document", source_ref: "test" }] },
      },
    },
  }, "2026-07-12");

  expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "PASS", critical: true, facts: ["profile.languages.german"] }));
});

test("passes a sufficient verified German level and includes its profile fact in survival", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\nLanguages: German B2 required\n");
  const result = evaluateVacancy({ id: "german_b2_verified", title: null, company: null, location: null }, extracted, {
    ...workspace,
    profile: {
      ...(workspace.profile as object),
      languages: {
        german: { value: { self_assessed_level: "B2" }, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
      },
    },
  }, "2026-07-12");
  expect(result.gates).toContainEqual(expect.objectContaining({ id: "language", status: "PASS", critical: true, facts: ["profile.languages.german"] }));
  expect(result.survival).toBe(100);
});

test("keeps an unknown shift as VERIFY rather than assuming it is suitable", async () => {
  const result = await evaluateFixture("unknown-shift.md");
  expect(result.gates).toContainEqual(expect.objectContaining({ id: "shift", status: "VERIFY" }));
});

test("keeps a placeholder shift as critical VERIFY rather than passing it", async () => {
  const result = await evaluateText("# Hardware Technician\nShift: TBD\n");

  expect(result.gates).toContainEqual(expect.objectContaining({ id: "shift", status: "VERIFY", critical: true }));
});

test("keeps an unreliable deadline VERIFY rather than treating it as current", async () => {
  const result = await evaluateText("# Hardware Technician\nDeadline: TBD\n");

  expect(result.gates).toContainEqual(expect.objectContaining({ id: "deadline", status: "VERIFY" }));
});

test("maps every material requirement once without promoting informal, planned, or education claims", async () => {
  const traineeText = await readFile(join(fixtureDirectory, "dct-trainee.md"), "utf8");
  const extracted = extractVacancy(traineeText);
  const result = evaluateVacancy({ id: "mapping_job", title: "Data Center Technician Trainee", company: null, location: null }, extracted, {
    ...workspace,
    evidence: {
      records: [
        { id: "PC_HARDWARE", kind: "hardware", statement: "Personal PC hardware experience reported by candidate.", reviewer_status: "unreviewed" },
        { id: "DISCORD_ASSISTANCE", kind: "informal_assistance", statement: "Informal Discord assistance", reviewer_status: "unreviewed" },
        { id: "HOME_LAB_PLAN", kind: "planned_project", statement: "Planned home lab", reviewer_status: "UNKNOWN" },
      ],
    },
  }, "2026-07-12");
  expect(result.mappings).toHaveLength(extracted.requirements.length);
  expect(result.mappings.find((mapping) => mapping.requirementId === extracted.requirements[0].id)).toMatchObject({ status: "partial", evidenceIds: ["PC_HARDWARE"] });
  expect(result.mappings.every((mapping) => ["proven", "partial", "transferable", "missing", "unknown", "contradicted"].includes(mapping.status))).toBe(true);

  const restricted: ExtractedJob = {
    ...extracted,
    requirements: [
      { id: "support", type: "skill", text: "professional support", spans: [], rule_ids: [] },
      { id: "home_lab", type: "skill", text: "home lab employment", spans: [], rule_ids: [] },
      { id: "theory", type: "skill", text: "networking theory", spans: [], rule_ids: [] },
      { id: "education", type: "education", text: "Ausbildung or degree equivalence", spans: [], rule_ids: [] },
    ],
  };
  const restrictedMappings = evaluateVacancy({ id: "restricted", title: null, company: null, location: null }, restricted, { ...workspace, evidence: {
    records: [
      { id: "DISCORD_ASSISTANCE", kind: "informal_assistance", statement: "Informal Discord assistance", reviewer_status: "unreviewed" },
      { id: "HOME_LAB_PLAN", kind: "planned_project", statement: "Planned home lab", reviewer_status: "UNKNOWN" },
    ],
  } }, "2026-07-12").mappings;
  expect(restrictedMappings.map((mapping) => mapping.status)).toEqual(["contradicted", "unknown", "unknown", "missing"]);
  expect(restrictedMappings.flatMap((mapping) => mapping.evidenceIds)).toEqual([]);
});

test("does not turn home-lab, planned, or theory evidence into ordinary skills", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\n");
  const restricted: ExtractedJob = {
    ...extracted,
    requirements: [
      { id: "planned", type: "skill", text: "hardware", spans: [], rule_ids: [] },
      { id: "home_lab", type: "skill", text: "hardware troubleshooting", spans: [], rule_ids: [] },
      { id: "home_lab_transferable", type: "skill", text: "server", spans: [], rule_ids: [] },
      { id: "theory", type: "skill", text: "networking", spans: [], rule_ids: [] },
    ],
  };
  const result = evaluateVacancy({ id: "disqualified_evidence", title: null, company: null, location: null }, restricted, {
    ...workspace,
    evidence: {
      records: [
        { id: "PLANNED", kind: "planned_project", statement: "Planned hardware project", reviewer_status: "unreviewed" },
        { id: "HOME_LAB", kind: "hardware", statement: "Home lab hardware troubleshooting", reviewer_status: "unreviewed" },
        { id: "THEORY", kind: "networking", statement: "Networking theory", reviewer_status: "unreviewed" },
      ],
    },
  }, "2026-07-12");
  expect(result.mappings.map((mapping) => ({ status: mapping.status, evidenceIds: mapping.evidenceIds }))).toEqual([
    { status: "unknown", evidenceIds: [] },
    { status: "unknown", evidenceIds: [] },
    { status: "unknown", evidenceIds: [] },
    { status: "unknown", evidenceIds: [] },
  ]);
});

test("does not promote hyphenated home-lab evidence to a proven ordinary skill", async () => {
  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\n");
  const result = evaluateVacancy({ id: "hyphenated_home_lab", title: null, company: null, location: null }, {
    ...extracted,
    requirements: [{ id: "hardware", type: "skill", text: "hardware troubleshooting", spans: [], rule_ids: [] }],
  }, {
    ...workspace,
    evidence: {
      records: [{ id: "HOME_LAB", kind: "hardware", statement: "Home-lab hardware troubleshooting", reviewer_status: "unreviewed" }],
    },
  }, "2026-07-12");
  expect(result.mappings).toEqual([expect.objectContaining({ status: "unknown", evidenceIds: [] })]);
});

test("maps schema-valid unreviewed evidence as partial instead of inventing review", async () => {
  const evidence = {
    schema_version: 1,
    records: [{
      id: "PC_HARDWARE",
      kind: "hardware",
      statement: "Personal PC hardware experience",
      reviewer_status: "unreviewed",
      provenance: [{ source_type: "user_statement", source_ref: "test" }],
    }],
  };
  expect(() => validateWorkspaceFile("evidence", evidence)).not.toThrow();

  const extracted = extractVacancy("# Hardware Technician\nSkills: PC hardware\n");
  const result = evaluateVacancy({ id: "schema_valid_evidence", title: null, company: null, location: null }, {
    ...extracted,
    requirements: [{ id: "hardware", type: "skill", text: "personal pc hardware experience", spans: [], rule_ids: [] }],
  }, { ...workspace, evidence }, "2026-07-12");

  expect(result.mappings).toEqual([expect.objectContaining({ status: "partial", evidenceIds: ["PC_HARDWARE"] })]);
});

test("is deterministic, makes blockers override fit, and keeps fit independent from verified survival facts", async () => {
  const carText = await readFile(join(fixtureDirectory, "own-car.md"), "utf8");
  const extracted = extractVacancy(carText);
  const job = { id: "car_job", title: "Field Hardware Technician", company: null, location: null };
  const withNoCar = evaluateVacancy(job, extracted, { ...workspace, evidence: { records: [{ id: "PC_HARDWARE", kind: "hardware", statement: "Personal PC hardware experience", reviewer_status: "unreviewed" }] } }, "2026-07-12");
  const repeated = evaluateVacancy(job, extracted, { ...workspace, evidence: { records: [{ id: "PC_HARDWARE", kind: "hardware", statement: "Personal PC hardware experience", reviewer_status: "unreviewed" }] } }, "2026-07-12");
  const withCar = evaluateVacancy(job, extracted, {
    ...workspace,
    profile: { ...(workspace.profile as object), transport: { has_car: { value: true, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] } } },
    evidence: { records: [{ id: "PC_HARDWARE", kind: "hardware", statement: "Personal PC hardware experience", reviewer_status: "unreviewed" }] },
  }, "2026-07-12");
  expect(repeated).toEqual(withNoCar);
  expect(withNoCar.fit).toBeGreaterThan(0);
  expect(withNoCar.tier).toBe("C");
  expect(withCar.fit).toBe(withNoCar.fit);
  expect(withCar.survival).not.toBe(withNoCar.survival);
});

test("builds a persistence graph with config provenance, run-scoped requirement storage IDs, mapping hashes, gates, scores, tier, and recommendation", async () => {
  const text = await readFile(join(fixtureDirectory, "a-hardware-dct.md"), "utf8");
  const extracted = extractVacancy(text);
  const result = evaluateVacancy({ id: "persisted_job", title: "Data Center Hardware Technician", company: null, location: null }, extracted, workspace, "2026-07-12");
  const input = buildEvaluationInput(result, extracted, workspace);
  expect(input.evaluatorVersion).toContain("evaluation-v1");
  expect(input.provenance).toContainEqual(expect.objectContaining({ source_type: "system" }));
  expect(input.requirements.map((requirement) => requirement.domain_id)).toEqual(extracted.requirements.map((requirement) => requirement.id));
  expect(input.requirements.map((requirement) => requirement.id)).not.toEqual(extracted.requirements.map((requirement) => requirement.id));
  expect(input.evidenceMappings.map((mapping) => mapping.domainId)).toEqual(result.mappings.map((mapping) => mapping.id));
  expect(input.evidenceMappings.map((mapping) => mapping.domainRequirementId)).toEqual(result.mappings.map((mapping) => mapping.requirementId));
  expect(input.evidenceMappings.map((mapping) => mapping.requirementId)).toEqual(input.requirements.map((requirement) => requirement.id));
  expect(input.evidenceMappings.every((mapping) => /^[a-f0-9]{64}$/.test(mapping.evidenceSnapshotHash))).toBe(true);
  expect(input.gateResults).toHaveLength(result.gates.length);
  expect(input.fitScores).toHaveLength(1);
  expect(input.survivalScores).toHaveLength(1);
  expect(input.applicationTiers).toHaveLength(1);
  expect(input.recommendations).toHaveLength(1);
});

async function evaluateText(text: string) {
  const extracted = extractVacancy(text);
  return evaluateVacancy({ id: "inline", title: extracted.fields.title.value, company: null, location: null }, extracted, workspace, "2026-07-12");
}
