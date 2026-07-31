import { expect, test } from "bun:test";
import { loadEmployerRegistry } from "../../packages/search/src/employer-registry";

test("Frankfurt employer registry keeps direct career sources policy-bound and city-configurable", async () => {
  const registry = await loadEmployerRegistry();
  expect(registry.cities).toContain("Frankfurt am Main");
  expect(registry.employers.find((employer) => employer.id === "maincubes")).toMatchObject({
    ats: "personio", policy: "public_ats_endpoint", enabled: true, track: "datacenter",
  });
  expect(registry.employers.find((employer) => employer.id === "dc-datacenter-group")).toMatchObject({
    ats: "personio", policy: "public_ats_endpoint", enabled: true, track: "datacenter",
  });
  expect(registry.employers.find((employer) => employer.id === "wingcopter")).toMatchObject({
    ats: "personio", policy: "public_ats_endpoint", enabled: true, track: "bridge",
  });
  expect(registry.employers.find((employer) => employer.id === "dsp-it-service")).toMatchObject({
    ats: "personio", policy: "public_ats_endpoint", enabled: true, track: "bridge",
  });
  expect(registry.employers.find((employer) => employer.id === "nlighten")).toMatchObject({
    ats: "greenhouse", policy: "public_ats_endpoint", enabled: true, track: "datacenter",
  });
  expect(registry.employers.find((employer) => employer.id === "enpal")).toMatchObject({
    ats: "ashby", policy: "public_ats_endpoint", enabled: true, track: "bridge",
  });
  expect(registry.employers.find((employer) => employer.id === "delta-electronics")).toMatchObject({
    ats: "smartrecruiters", policy: "public_ats_endpoint", enabled: true, track: "datacenter",
  });
  expect(registry.employers.find((employer) => employer.id === "teccle-group")).toMatchObject({
    ats: "recruitee", policy: "public_ats_endpoint", enabled: true, track: "bridge",
  });
  expect(registry.employers.find((employer) => employer.id === "amadeus-fire")).toMatchObject({
    source_kind: "agency", policy: "manual_only", enabled: true,
  });
  expect(registry.employers.find((employer) => employer.id === "randstad")).toMatchObject({
    source_kind: "agency", policy: "manual_only", enabled: true,
  });
  expect(registry.employers.find((employer) => employer.id === "equinix")).toMatchObject({
    ats: "unknown", policy: "manual_only",
  });
  expect(registry.employers.find((employer) => employer.id === "cyrusone")).toMatchObject({
    ats: "workday", policy: "manual_only",
  });
  expect(registry.employers.find((employer) => employer.id === "de-cix")).toMatchObject({
    ats: "onlyfy", policy: "manual_only",
  });
});
