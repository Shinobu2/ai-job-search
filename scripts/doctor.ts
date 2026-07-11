import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { validateWorkspaceFile, workspaceNames } from "../packages/core/src/workspace";

export interface DoctorReport {
  errors: string[];
  warnings: string[];
}

function requireTool(tool: string, strict: boolean, report: DoctorReport): void {
  if (Bun.which(tool)) return;
  const message = `${tool} is not available`;
  (strict ? report.errors : report.warnings).push(message);
}

export async function runDoctor(root: string, strict = false): Promise<DoctorReport> {
  const report: DoctorReport = { errors: [], warnings: [] };
  if (!process.versions.bun) report.errors.push("Bun is not running this command");
  requireTool("python", true, report);
  requireTool("lualatex", strict, report);
  requireTool("xelatex", strict, report);
  requireTool("pdftotext", strict, report);

  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  for (const rule of [".vs/", "workspace/"]) {
    if (!gitignore.split(/\r?\n/).includes(rule)) report.errors.push(`.gitignore is missing ${rule}`);
  }

  for (const name of workspaceNames) {
    try {
      validateWorkspaceFile(name, parse(await readFile(join(root, "workspace.example", `${name}.yml`), "utf8")));
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : `Invalid ${name} schema`);
    }
  }

  const guard = Bun.spawnSync(["python", "tools/security_guards.py"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (guard.exitCode !== 0) report.errors.push("security guards failed");
  if (!existsSync(join(root, "packages", "storage", "src", "database.ts"))) {
    report.warnings.push("SQLite initialization is unavailable until Task 2");
  }
  return report;
}
