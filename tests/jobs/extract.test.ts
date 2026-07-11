import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractVacancy } from "../../packages/jobs/src/extract";

const fixtureDirectory = join(import.meta.dir, "../fixtures/jobs");

async function traineeText(): Promise<string> {
  return readFile(join(fixtureDirectory, "dct-trainee.md"), "utf8");
}

test("extracts the versioned vacancy fields and stable requirements from deterministic rules", async () => {
  const text = await traineeText();
  const extracted = extractVacancy(text);

  expect(extracted.version).toBe("extraction-v1");
  expect(extracted.fields).toMatchObject({
    title: { state: "known", value: "Data Center Technician Trainee" },
    company: { state: "known", value: "NorthStar Data GmbH" },
    location: { state: "known", value: "Berlin, Germany" },
    exact_workplace: { state: "known", value: "NorthStar Campus, Alexanderufer 3, 10117 Berlin" },
    employment_type: { state: "known", value: "Full-time" },
    contract_type: { state: "known", value: "Permanent" },
    salary: { state: "known", value: "€36,000 gross per year" },
    languages: { state: "known", value: "English required; German is a plus" },
    education: { state: "known", value: "Completed IT vocational training or comparable education" },
    experience: { state: "known", value: "Entry level; no professional experience required" },
    skills: { state: "known", value: "PC hardware, server installation, Linux, cable management" },
    certifications: { state: "known", value: "CompTIA A+ preferred" },
    shift: { state: "known", value: "Rotating shifts including night work" },
    night_work: { state: "known", value: "required" },
    on_call: { state: "known", value: "On-call rotation required" },
    car: { state: "known", value: "No own car required" },
    physical_requirements: { state: "known", value: "Ability to lift up to 20 kg" },
    training: { state: "known", value: "Structured trainee programme and mentor" },
    seniority: { state: "known", value: "Trainee / junior" },
    deadline: { state: "known", value: "2026-08-31" },
  });
  expect(extracted.requirements.map(({ id, type, text: requirementText }) => ({ id, type, text: requirementText }))).toEqual([
    { id: "requirement_4ddfe3bf235bcd59", type: "skill", text: "PC hardware" },
    { id: "requirement_ed529a130c3c55cf", type: "skill", text: "server installation" },
    { id: "requirement_a783a87b8c758884", type: "skill", text: "Linux" },
    { id: "requirement_a9b7b1dd5e2f7550", type: "skill", text: "cable management" },
  ]);
  expect(extracted.uncertainties).toEqual([]);
  expect(extractVacancy(text)).toEqual(extracted);
});

test("marks absent required posting facts unknown and retains source spans for known values", async () => {
  const text = await readFile(join(fixtureDirectory, "a-hardware-dct.md"), "utf8");
  const extracted = extractVacancy(text);
  const salary = extracted.fields.salary;
  const location = extracted.fields.location;

  expect(salary).toEqual({ state: "unknown", value: null, spans: [], rule_ids: ["salary.label"] });
  expect(extracted.fields.on_call).toEqual({ state: "unknown", value: null, spans: [], rule_ids: ["on_call.label"] });
  expect(extracted.uncertainties).toContain("salary");
  expect(extracted.uncertainties).toContain("on_call");
  expect(location.spans).toHaveLength(1);
  expect(text.slice(location.spans[0].start, location.spans[0].end)).toBe("Frankfurt am Main, Germany");
});
