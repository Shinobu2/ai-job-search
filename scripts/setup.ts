import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { validateWorkspaceFile, workspaceNames, type WorkspaceFileName } from "../packages/core/src/workspace";
import { CapabilityRegistry } from "../packages/storage/src/capabilities";
import { openDatabase } from "../packages/storage/src/database";
import { migrate } from "../packages/storage/src/migrate";

export interface SetupSummary {
  created: string[];
  updated: string[];
  unknown_paths: string[];
  unverified_paths: string[];
  database_migrations: string[];
}

function mergeDefaults(defaultValue: unknown, existingValue: unknown): unknown {
  if (Array.isArray(existingValue) || Array.isArray(defaultValue)) return existingValue;
  if (isRecord(defaultValue) && isRecord(existingValue)) {
    const merged = { ...existingValue };
    for (const [key, value] of Object.entries(defaultValue)) {
      merged[key] = key in existingValue ? mergeDefaults(value, existingValue[key]) : value;
    }
    return merged;
  }
  return existingValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findPathsWithStatuses(value: unknown, statuses: string[], path = ""): string[] {
  if (!isRecord(value)) return [];
  const own = typeof value.verification_status === "string" && statuses.includes(value.verification_status) ? [path] : [];
  return [
    ...own,
    ...Object.entries(value).flatMap(([key, child]) =>
      key === "provenance" || key === "verification_status" || key === "value"
        ? []
        : findPathsWithStatuses(child, statuses, path ? `${path}.${key}` : key),
    ),
  ];
}

async function replaceAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, path);
}

export async function setupWorkspace(root: string): Promise<SetupSummary> {
  const workspaceDirectory = join(root, "workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const summary: SetupSummary = { created: [], updated: [], unknown_paths: [], unverified_paths: [], database_migrations: [] };

  for (const name of workspaceNames) {
    const filename = `${name}.yml`;
    const defaultValue = parse(await readFile(join(import.meta.dir, "../workspace.example", filename), "utf8"));
    const destination = join(workspaceDirectory, filename);
    let finalValue = defaultValue;
    let existed = true;
    try {
      finalValue = mergeDefaults(defaultValue, parse(await readFile(destination, "utf8")));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      existed = false;
    }
    validateWorkspaceFile(name as WorkspaceFileName, finalValue);
    if (!existed) {
      await replaceAtomically(destination, stringify(finalValue));
      summary.created.push(filename);
    } else if (JSON.stringify(finalValue) !== JSON.stringify(parse(await readFile(destination, "utf8")))) {
      await replaceAtomically(destination, stringify(finalValue));
      summary.updated.push(filename);
    }
    summary.unknown_paths.push(...findPathsWithStatuses(finalValue, ["unknown"], name));
    summary.unverified_paths.push(...findPathsWithStatuses(finalValue, ["unknown", "user_confirmed"], name));
  }
  summary.created.sort();
  summary.updated.sort();
  summary.unknown_paths.sort();
  summary.unverified_paths.sort();
  const db = openDatabase(join(workspaceDirectory, "control-room.sqlite"));
  try {
    summary.database_migrations = migrate(db).applied;
    new CapabilityRegistry(db).seed();
  } finally {
    db.close();
  }
  return summary;
}
