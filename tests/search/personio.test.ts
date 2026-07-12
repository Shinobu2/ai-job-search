import { expect, test } from "bun:test";
import { parsePersonioXml, readPersonioEmployer } from "../../packages/search/src/personio";

test("Personio reader extracts published job title, office and description without application actions", () => {
  const jobs = parsePersonioXml(`<?xml version="1.0"?><workzag-jobs><position><name>Service Desk Agent</name><office>Frankfurt am Main</office><jobDescriptions><jobDescription><name>Beschreibung</name><value>Hardware support</value></jobDescription></jobDescriptions><id>42</id></position></workzag-jobs>`);
  expect(jobs).toEqual([{ id: "42", title: "Service Desk Agent", location: "Frankfurt am Main", description: "Hardware support" }]);
});

test("Personio reader uses only approved registry endpoints and performs GET-only XML reads", async () => {
  const requested: string[] = [];
  const jobs = await readPersonioEmployer({ id: "maincubes", name: "maincubes", cities: ["Frankfurt am Main"], career_url: "https://maincubes-1.jobs.personio.de/?language=de", ats: "personio", policy: "public_ats_endpoint", enabled: true }, (async (input, init) => {
    requested.push(String(input));
    expect(init?.redirect).toBe("error");
    return new Response(`<workzag-jobs><position><id>42</id><name>Technician</name><office>Frankfurt</office></position></workzag-jobs>`, { status: 200 });
  }) as typeof fetch);
  expect(requested).toEqual(["https://maincubes-1.jobs.personio.de/xml"]);
  expect(jobs[0]?.id).toBe("42");
  await expect(readPersonioEmployer({ id: "manual", name: "Manual", cities: [], career_url: "https://example.com/jobs", ats: "unknown", policy: "manual_only", enabled: true })).rejects.toThrow("not approved");
});
