import { expect, test } from "bun:test";
import { parsePersonioXml } from "../../packages/search/src/personio";

test("Personio reader extracts published job title, office and description without application actions", () => {
  const jobs = parsePersonioXml(`<?xml version="1.0"?><workzag-jobs><position><name>Service Desk Agent</name><office>Frankfurt am Main</office><jobDescriptions><jobDescription><name>Beschreibung</name><value>Hardware support</value></jobDescription></jobDescriptions><id>42</id></position></workzag-jobs>`);
  expect(jobs).toEqual([{ id: "42", title: "Service Desk Agent", location: "Frankfurt am Main", description: "Hardware support" }]);
});
