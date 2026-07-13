import { expect, test } from "bun:test";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import { discoverPersonioEmployer, parsePersonioXml, readPersonioEmployer } from "../../packages/search/src/personio";

const employer = { id: "maincubes", name: "maincubes", cities: ["Frankfurt am Main"], career_url: "https://maincubes-1.jobs.personio.de/?language=de", ats: "personio", policy: "public_ats_endpoint" as const, enabled: true };
const workspace = {
  profile: {
    constraints: { night_shifts: { value: "unknown", verification_status: "unknown", provenance: [] }, continuous_heavy_work: { value: "unknown", verification_status: "unknown", provenance: [] } },
    transport: { has_car: { value: null, verification_status: "unknown", provenance: [] } },
    languages: { english: { value: null, verification_status: "unknown", provenance: [] }, german: { value: null, verification_status: "unknown", provenance: [] } },
    compensation: { net_monthly_estimate: { value: null, verification_status: "unknown", provenance: [] } },
  },
  evidence: { records: [] }, "document-pack": {}, search: {}, "auto-apply": {},
};

test("Personio reader extracts published job title, office and description without application actions", () => {
  const jobs = parsePersonioXml(`<?xml version="1.0"?><workzag-jobs><position><name>Service Desk Agent</name><office>Frankfurt am Main</office><jobDescriptions><jobDescription><name>Beschreibung</name><value>Hardware support</value></jobDescription></jobDescriptions><id>42</id></position></workzag-jobs>`);
  expect(jobs).toEqual([{ id: "42", title: "Service Desk Agent", location: "Frankfurt am Main", locations: ["Frankfurt am Main"], description: "Hardware support" }]);
});

test("Personio parser handles CDATA, entities, nested markup, repeated offices, and missing optional fields", () => {
  const jobs = parsePersonioXml(`<?xml version="1.0"?>
    <workzag-jobs>
      <position>
        <id>4&#50;</id><name><![CDATA[Service &amp; Support]]></name>
        <office>Frankfurt &amp; Main</office><office>Eschborn &#x26; West</office>
        <jobDescriptions><jobDescription><value><![CDATA[<p>Hardware &amp; support</p>]]></value></jobDescription>
        <jobDescription><value><div>Replace <strong>servers</strong></div></value></jobDescription></jobDescriptions>
      </position>
      <position><id>43</id><name>Optional fields absent</name></position>
    </workzag-jobs>`);
  expect(jobs).toEqual([
    { id: "42", title: "Service & Support", location: "Frankfurt & Main", locations: ["Frankfurt & Main", "Eschborn & West"], description: "Hardware & support\nReplace servers" },
    { id: "43", title: "Optional fields absent", location: null, locations: [], description: "" },
  ]);
});

test("Personio parser rejects malformed or unbalanced XML", () => {
  expect(() => parsePersonioXml("<workzag-jobs><position><id>42</id></workzag-jobs>")).toThrow("Malformed XML");
  expect(() => parsePersonioXml("<workzag-jobs><position></position></workzag-jobs>")).toThrow("position requires id and name");
});

test("Personio parser is case-sensitive and rejects unknown or malformed entities", () => {
  expect(() => parsePersonioXml("<workzag-jobs><position><id>42</ID><name>Technician</name></position></workzag-jobs>")).toThrow("Malformed XML");
  expect(() => parsePersonioXml("<workzag-jobs><position><id>42</id><name>R&ampbogus;D</name></position></workzag-jobs>")).toThrow("entity");
  expect(() => parsePersonioXml("<workzag-jobs><position><id>42</id><name>R&bogus;</name></position></workzag-jobs>")).toThrow("entity");
});

test("Personio reader treats missing required position identity and empty XML as parse failures", async () => {
  for (const xml of ["<workzag-jobs><position><office>Frankfurt</office></position></workzag-jobs>", ""]) {
    const batch = await readPersonioEmployer(employer, (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch);
    expect(batch.status).toBe("failed");
    expect(batch.jobs).toEqual([]);
    expect(batch.diagnostics).toEqual([expect.objectContaining({ stage: "parse", code: "invalid_xml", transient: false })]);
  }
});

test("Personio reader uses only approved registry endpoints and performs GET-only XML reads", async () => {
  const requested: string[] = [];
  const batch = await readPersonioEmployer(employer, (async (input, init) => {
    requested.push(String(input));
    expect(init?.redirect).toBe("error");
    expect(init?.method ?? "GET").toBe("GET");
    return new Response(`<workzag-jobs><position><id>42</id><name>Technician</name><office>Frankfurt</office></position></workzag-jobs>`, { status: 200 });
  }) as typeof fetch);
  expect(requested).toEqual(["https://maincubes-1.jobs.personio.de/xml"]);
  expect(batch.jobs[0]?.id).toBe("42");
  expect(batch.counters).toEqual({ searched: 1, detailed: 1, imported: 0, skipped: 0, failed: 0 });
  await expect(readPersonioEmployer({ id: "manual", name: "Manual", cities: [], career_url: "https://example.com/jobs", ats: "unknown", policy: "manual_only", enabled: true })).rejects.toThrow("not approved");
});

test("Personio reader retries transient failures twice and translates malformed XML into diagnostics", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const failed = await readPersonioEmployer(employer, (async () => {
    attempts += 1;
    if (attempts === 1) return new Response("busy", { status: 429 });
    if (attempts === 2) return new Response("down", { status: 502 });
    throw new DOMException("timed out", "TimeoutError");
  }) as unknown as typeof fetch, { sleep: async (delay) => { delays.push(delay); } });
  expect(attempts).toBe(3);
  expect(delays).toEqual([250, 500]);
  expect(failed.jobs).toEqual([]);
  expect(failed.diagnostics).toEqual([expect.objectContaining({ stage: "search", locator: "maincubes", code: "timeout", transient: true })]);

  attempts = 0;
  const malformed = await readPersonioEmployer(employer, (async () => {
    attempts += 1;
    return new Response("<workzag-jobs><position></workzag-jobs>", { status: 200 });
  }) as unknown as typeof fetch, { sleep: async () => { throw new Error("parse must not retry"); } });
  expect(attempts).toBe(1);
  expect(malformed.diagnostics).toEqual([expect.objectContaining({ stage: "parse", code: "invalid_xml", transient: false })]);
});

test("Personio discovery imports and observes jobs before actionability filtering", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const batch = await discoverPersonioEmployer(employer, new StorageRepository(db), workspace as never, {
      fetcher: (async () => new Response(`<workzag-jobs>
        <position><id>42</id><name>Frankfurt technician</name><office>Frankfurt</office></position>
        <position><id>43</id><name>Munich technician</name><office>Munich</office></position>
        <position><id>44</id><name>Unknown location</name></position>
      </workzag-jobs>`, { status: 200 })) as unknown as typeof fetch,
    });
    expect(batch.jobs.map(({ sourceId, actionable }) => ({ sourceId, actionable }))).toEqual([
      { sourceId: "personio:maincubes:42", actionable: true },
      { sourceId: "personio:maincubes:43", actionable: false },
      { sourceId: "personio:maincubes:44", actionable: true },
    ]);
    expect(batch.status).toBe("success");
    expect(batch.scope).toEqual({ planned: 1, completed: 1, failed: 0 });
    expect(batch.jobs[0]).toMatchObject({ stableSourceId: "personio:maincubes:42", logicalVacancyId: expect.stringContaining("vacancy_"), version: 1 });
    expect(batch.counters).toEqual({ searched: 1, detailed: 3, imported: 3, skipped: 1, failed: 0 });
    expect(batch.diagnostics.map((entry) => entry.code)).toEqual(["out_of_area", "location_unknown"]);
    expect(db.query("SELECT COUNT(*) AS count FROM discovery_observations").get()).toEqual({ count: 3 });
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "success" });
  } finally {
    db.close();
  }
});

test("Personio malformed discovery finishes its run instead of leaving it running", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const batch = await discoverPersonioEmployer(employer, new StorageRepository(db), workspace as never, {
      fetcher: (async () => new Response("<workzag-jobs><position></workzag-jobs>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(batch.status).toBe("failed");
    expect(db.query("SELECT status FROM discovery_runs").get()).toEqual({ status: "failed" });
    expect(db.query("SELECT COUNT(*) AS count FROM discovery_runs WHERE status = 'running'").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});
