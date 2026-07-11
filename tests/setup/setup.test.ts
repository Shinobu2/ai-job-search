import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { setupWorkspace } from "../../scripts/setup";
import { runDoctor } from "../../scripts/doctor";

async function copyExamplesToTemp() {
  const root = await mkdtemp(join(tmpdir(), "career-control-room-"));
  await cp("workspace.example", join(root, "workspace"), { recursive: true });
  return root;
}

async function readYaml(path: string) {
  return parse(await readFile(path, "utf8"));
}

async function writeYaml(path: string, value: unknown) {
  await writeFile(path, stringify(value), "utf8");
}

test("setup creates missing workspace files and reports unknown values", async () => {
  const root = await mkdtemp(join(tmpdir(), "career-control-room-"));
  try {
    const summary = await setupWorkspace(root);

    expect(summary.created).toEqual([
      "auto-apply.yml",
      "document-pack.yml",
      "evidence.yml",
      "profile.yml",
      "search.yml",
    ]);
    expect(summary.unknown_paths).toContain("profile.legal.work_authorization");
    expect(summary.unverified_paths).toContain("profile.locations.radius_km");
    expect(await Bun.file(join(root, "workspace", "profile.yml")).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup rerun preserves existing user scalar map and list values", async () => {
  const root = await copyExamplesToTemp();
  try {
    await setupWorkspace(root);
    const profilePath = join(root, "workspace", "profile.yml");
    const profile = await readYaml(profilePath);
    profile.locations.radius_km.value = 55;
    profile.locations.city.value = { name: "Darmstadt", country: "Germany" };
    profile.targets.primary_archetypes.value = ["custom-target"];
    await writeYaml(profilePath, profile);
    await rm(join(root, "workspace", "auto-apply.yml"));

    const summary = await setupWorkspace(root);
    const rerunProfile = await readYaml(profilePath);

    expect(rerunProfile.locations.radius_km.value).toBe(55);
    expect(rerunProfile.locations.city.value).toEqual({ name: "Darmstadt", country: "Germany" });
    expect(rerunProfile.targets.primary_archetypes.value).toEqual(["custom-target"]);
    expect(summary.created).toEqual(["auto-apply.yml"]);
    expect(await Bun.file(join(root, "workspace", "auto-apply.yml")).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup rerun preserves additional keys inside a user-owned map value", async () => {
  const root = await copyExamplesToTemp();
  try {
    const profilePath = join(root, "workspace", "profile.yml");
    const profile = await readYaml(profilePath);
    profile.locations.city.value.district = "Sachsenhausen";
    await writeYaml(profilePath, profile);

    await setupWorkspace(root);

    expect((await readYaml(profilePath)).locations.city.value).toEqual({
      name: "Frankfurt",
      country: "Germany",
      district: "Sachsenhausen",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports a missing gitignore instead of throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "career-control-room-"));
  try {
    const report = await runDoctor(root);

    expect(report.errors).toContain(".gitignore is missing or unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
