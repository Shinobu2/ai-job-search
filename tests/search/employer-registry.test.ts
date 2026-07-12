import { expect, test } from "bun:test";
import { loadEmployerRegistry } from "../../packages/search/src/employer-registry";

test("Frankfurt employer registry keeps direct career sources policy-bound and city-configurable", async () => {
  const registry = await loadEmployerRegistry();
  expect(registry.cities).toContain("Frankfurt am Main");
  expect(registry.employers.find((employer) => employer.id === "maincubes")).toMatchObject({
    ats: "personio", policy: "public_ats_endpoint", enabled: true,
  });
  expect(registry.employers.find((employer) => employer.id === "equinix")).toMatchObject({ policy: "manual_only" });
});
