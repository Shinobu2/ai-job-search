import { expect, test } from "bun:test";
import { parse } from "yaml";
import { validateWorkspaceFile } from "../../packages/core/src/workspace";

const examples = [
  "profile",
  "evidence",
  "document-pack",
  "search",
  "auto-apply",
] as const;

async function readExample(name: (typeof examples)[number]) {
  return parse(await Bun.file(`workspace.example/${name}.yml`).text());
}

test("all authoritative workspace examples validate", async () => {
  for (const name of examples) {
    validateWorkspaceFile(name, await readExample(name));
  }
});

test("profile keeps unknown candidate facts explicit and established facts user-confirmed", async () => {
  const profile = await readExample("profile");

  expect(profile.legal.work_authorization).toEqual({
    value: null,
    verification_status: "unknown",
    provenance: [],
  });
  expect(profile.legal.education_equivalence).toEqual({
    value: null,
    verification_status: "unknown",
    provenance: [],
  });
  expect(profile.locations.radius_km).toMatchObject({
    value: 40,
    verification_status: "user_confirmed",
    provenance: [
      {
        source_type: "user_statement",
        source_ref: "initial_project_specification",
      },
    ],
  });
  expect(profile.compensation.net_monthly_estimate).toMatchObject({
    value: { floor_eur: 1750, target_eur: 2000 },
    verification_status: "user_confirmed",
    provenance: [
      {
        source_type: "user_statement",
        source_ref: "initial_project_specification",
      },
    ],
  });
});

test("profile rejects inferred legal status", async () => {
  const profile = await readExample("profile");
  profile.legal.work_authorization = {
    value: "eligible_to_work_in_germany",
    verification_status: "user_confirmed",
    provenance: [
      {
        source_type: "user_statement",
        source_ref: "inferred_from_location",
      },
    ],
  };

  expect(() => validateWorkspaceFile("profile", profile)).toThrow();
});
