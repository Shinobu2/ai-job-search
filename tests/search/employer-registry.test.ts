import { expect, test } from "bun:test";
import { PUBLIC_ATS_TYPES } from "../../packages/search/src/ats";
import {
  loadEmployerRegistry,
  validateEmployerRegistry,
  type EmployerRegistry,
} from "../../packages/search/src/employer-registry";

function validRegistry(): EmployerRegistry {
  return {
    version: "employer-registry-v1",
    cities: ["Frankfurt am Main"],
    employers: [
      {
        id: "public-employer",
        name: "Public Employer",
        track: "datacenter",
        cities: ["Frankfurt am Main"],
        career_url: "https://jobs.example/public",
        ats: "personio",
        policy: "public_ats_endpoint",
        enabled: true,
      },
      {
        id: "manual-employer",
        name: "Manual Employer",
        track: "airport_logistics",
        cities: ["Kelsterbach"],
        career_url: "https://jobs.example/manual",
        ats: "workday",
        policy: "manual_only",
        source_kind: "employer",
        content_language_fallback: "de",
        enabled: false,
      },
    ],
  };
}

test("accepts a complete employer registry and every supported public ATS", () => {
  expect(() => validateEmployerRegistry(validRegistry())).not.toThrow();
  for (const ats of PUBLIC_ATS_TYPES) {
    const registry = validRegistry();
    registry.employers[0]!.ats = ats;
    expect(() => validateEmployerRegistry(registry)).not.toThrow();
  }
});

test("rejects the wrong registry version and empty registry or employer cities", () => {
  const registry = validRegistry();
  (registry as unknown as { version: string }).version = "employer-registry-v2";
  registry.cities = [];
  registry.employers[0]!.cities = [];

  expect(() => validateEmployerRegistry(registry)).toThrow(/Invalid employer registry:[\s\S]*\/version[\s\S]*\/cities[\s\S]*\/employers\/0\/cities/);
});

test("requires every employer identity, routing, policy, and enabled field", () => {
  const required = ["id", "name", "track", "cities", "career_url", "ats", "policy", "enabled"] as const;
  for (const field of required) {
    const registry = validRegistry();
    delete (registry.employers[0] as unknown as Record<string, unknown>)[field];
    expect(() => validateEmployerRegistry(registry)).toThrow(new RegExp(`required property '${field}'`));
  }
});

test("rejects unsupported policies", () => {
  const registry = validRegistry();
  (registry.employers[0] as unknown as Record<string, unknown>).policy = "scrape_anyway";
  expect(() => validateEmployerRegistry(registry)).toThrow(/\/employers\/0\/policy/);
});

test("restricts public endpoints to PUBLIC_ATS_TYPES but permits manual ATS labels", () => {
  const publicRegistry = validRegistry();
  publicRegistry.employers[0]!.ats = "workday";
  expect(() => validateEmployerRegistry(publicRegistry)).toThrow(/\/employers\/0\/ats/);

  const manualRegistry = validRegistry();
  expect(() => validateEmployerRegistry(manualRegistry)).not.toThrow();
});

test("rejects duplicate employer ids even when the remaining entries differ", () => {
  const registry = validRegistry();
  registry.employers[1]!.id = registry.employers[0]!.id;
  expect(() => validateEmployerRegistry(registry)).toThrow(/\/employers\/1\/id duplicate employer id "public-employer"/);
});

test("reports every schema and duplicate-id violation in one error", () => {
  const registry = validRegistry();
  (registry as unknown as { version: string }).version = "wrong";
  registry.cities = [];
  registry.employers[1]!.id = registry.employers[0]!.id;

  let message = "";
  try {
    validateEmployerRegistry(registry);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toStartWith("Invalid employer registry:");
  expect(message).toContain("/version");
  expect(message).toContain("/cities");
  expect(message).toContain("/employers/1/id duplicate employer id");
});

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
