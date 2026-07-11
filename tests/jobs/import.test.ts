import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import { importVacancy } from "../../packages/jobs/src/import";

const fixtureDirectory = join(import.meta.dir, "../fixtures/jobs");

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-import-"));
  const db = openDatabase(join(directory, "control-room.sqlite"));
  migrate(db);
  return { directory, db, repository: new StorageRepository(db) };
}

const vacancy = [
  "# Platform Technician",
  "Company: Example GmbH",
  "Location: Berlin, Germany",
  "Skills: Linux",
].join("\n");

test("imports pasted text and preserves its raw source hash", async () => {
  const fixture = await repository();
  try {
    const imported = await importVacancy({ text: vacancy }, fixture.repository);
    const source = fixture.db.query("SELECT s.raw_content, s.raw_hash, s.source_type FROM job_sources s JOIN jobs j ON j.source_id = s.id WHERE j.id = ?").get(imported.id) as {
      raw_content: string;
      raw_hash: string;
      source_type: string;
    };

    expect(imported).toMatchObject({ reused: false, title: "Platform Technician", company: "Example GmbH", location: "Berlin, Germany" });
    expect(source).toEqual({
      raw_content: vacancy,
      raw_hash: createHash("sha256").update(vacancy).digest("hex"),
      source_type: "pasted_text",
    });
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("imports local text and Markdown files", async () => {
  const fixture = await repository();
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-import-files-"));
  try {
    const textPath = join(directory, "vacancy.txt");
    await writeFile(textPath, vacancy, "utf8");
    const fromText = await importVacancy({ file: textPath }, fixture.repository);
    const fromMarkdown = await importVacancy({ file: join(fixtureDirectory, "dct-trainee.md") }, fixture.repository);

    expect(fromText).toMatchObject({ reused: false, title: "Platform Technician" });
    expect(fromMarkdown).toMatchObject({ reused: false, title: "Data Center Technician Trainee", company: "NorthStar Data GmbH" });
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists a BOM-prefixed local text source that hashes to its stored raw hash", async () => {
  const fixture = await repository();
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-import-bom-"));
  try {
    const textPath = join(directory, "bom-vacancy.txt");
    const rawContent = `\ufeff${vacancy}`;
    await writeFile(textPath, rawContent, "utf8");
    const imported = await importVacancy({ file: textPath }, fixture.repository);
    const source = fixture.db.query("SELECT s.raw_content, s.raw_hash FROM job_sources s JOIN jobs j ON j.source_id = s.id WHERE j.id = ?").get(imported.id) as {
      raw_content: string;
      raw_hash: string;
    };

    expect(source.raw_content).toBe(rawContent);
    expect(source.raw_hash).toBe(createHash("sha256").update(await readFile(textPath)).digest("hex"));
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses visible local HTML text while retaining the original source", async () => {
  const fixture = await repository();
  const file = join(fixtureDirectory, "local-html.html");
  try {
    const imported = await importVacancy({ file }, fixture.repository);
    const source = fixture.db.query("SELECT s.raw_content FROM job_sources s JOIN jobs j ON j.source_id = s.id WHERE j.id = ?").get(imported.id) as { raw_content: string };

    expect(imported).toMatchObject({ title: "Local HTML Support Technician", company: "Visible Web GmbH", location: "Cologne, Germany" });
    expect(source.raw_content).toBe(await readFile(file, "utf8"));
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("never fetches supplied URLs", async () => {
  const fixture = await repository();
  try {
    const imported = await importVacancy({ text: vacancy, sourceUrl: "https://127.0.0.1:1/not-fetched" }, fixture.repository);
    expect(imported.reused).toBe(false);
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects missing and unsupported local files clearly", async () => {
  const fixture = await repository();
  const directory = await mkdtemp(join(tmpdir(), "career-control-room-import-errors-"));
  try {
    await writeFile(join(directory, "vacancy.pdf"), "not a PDF", "utf8");
    await expect(importVacancy({ file: join(directory, "missing.md") }, fixture.repository)).rejects.toThrow("Local file does not exist");
    await expect(importVacancy({ file: join(directory, "vacancy.pdf") }, fixture.repository)).rejects.toThrow("Unsupported local file type");
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses the matching job by canonical URL before other identities", async () => {
  const fixture = await repository();
  try {
    const first = await importVacancy({ text: vacancy, sourceUrl: "HTTPS://Example.test/jobs/42/" }, fixture.repository);
    const second = await importVacancy({ text: "# Different title", sourceUrl: "https://example.test/jobs/42" }, fixture.repository);
    expect(second).toMatchObject({ id: first.id, reused: true });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses the matching job by source ID before normalized fields", async () => {
  const fixture = await repository();
  try {
    const first = await importVacancy({ text: vacancy, sourceId: "vendor-123" }, fixture.repository);
    const second = await importVacancy({ text: "# Different title", sourceId: "vendor-123" }, fixture.repository);
    expect(second).toMatchObject({ id: first.id, reused: true });
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses the matching job by normalized company, title, and location before hash", async () => {
  const fixture = await repository();
  try {
    const first = await importVacancy({ text: vacancy }, fixture.repository);
    const second = await importVacancy({ text: `${vacancy}\nSkills: Windows` }, fixture.repository);
    expect(second).toMatchObject({ id: first.id, reused: true });
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses the matching job by raw content hash", async () => {
  const fixture = await repository();
  try {
    const first = await importVacancy({ text: "Unstructured local vacancy" }, fixture.repository);
    const second = await importVacancy({ text: "Unstructured local vacancy" }, fixture.repository);
    expect(second).toMatchObject({ id: first.id, reused: true });
  } finally {
    fixture.db.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
