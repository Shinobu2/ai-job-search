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

test("profile rejects user-confirmed facts without user-statement provenance", async () => {
  const profile = await readExample("profile");
  profile.locations.radius_km.provenance = [];

  expect(() => validateWorkspaceFile("profile", profile)).toThrow();

  profile.locations.radius_km.provenance = [
    { source_type: "document", source_ref: "unrelated-document" },
  ];
  expect(() => validateWorkspaceFile("profile", profile)).toThrow();
});

test("evidence rejects completed or employment claims for planned projects", async () => {
  const evidence = await readExample("evidence");
  const homeLab = evidence.records.find((record: { id: string }) => record.id === "HOME_LAB_PLAN");
  homeLab.statement =
    "Completed home lab employment.";

  expect(() => validateWorkspaceFile("evidence", evidence)).toThrow();

  homeLab.statement = "COMPLETED HOME LAB EMPLOYMENT.";
  expect(() => validateWorkspaceFile("evidence", evidence)).toThrow();
});

test("evidence rejects professional-support claims for informal assistance", async () => {
  const evidence = await readExample("evidence");
  const discord = evidence.records.find((record: { id: string }) => record.id === "DISCORD_ASSISTANCE");
  discord.statement =
    "Professional Discord support.";

  expect(() => validateWorkspaceFile("evidence", evidence)).toThrow();

  discord.statement = "PROFESSIONAL Discord support.";
  expect(() => validateWorkspaceFile("evidence", evidence)).toThrow();
});

test("evidence enforces reviewer status for each established evidence kind", async () => {
  for (const id of ["PC_HARDWARE", "ROUTER", "DISCORD_ASSISTANCE"]) {
    const evidence = await readExample("evidence");
    evidence.records.find((record: { id: string }) => record.id === id).reviewer_status = "UNKNOWN";

    expect(() => validateWorkspaceFile("evidence", evidence)).toThrow();
  }

  const evidence = await readExample("evidence");
  evidence.records.find((record: { id: string }) => record.id === "HOME_LAB_PLAN").reviewer_status =
    "unreviewed";

  expect(() => validateWorkspaceFile("evidence", evidence)).toThrow();
});

test("search example has no duplicate candidate agencies policy", async () => {
  const search = await readExample("search");

  expect(search.agencies_policy).toBeUndefined();
});
