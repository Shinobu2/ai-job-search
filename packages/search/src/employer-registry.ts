import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type EmployerPolicy = "public_ats_endpoint" | "manual_only";
export type EmployerRegistry = { version: "employer-registry-v1"; cities: string[]; employers: Array<{ id: string; name: string; cities: string[]; career_url: string; ats: string; policy: EmployerPolicy; enabled: boolean }> };

export async function loadEmployerRegistry(): Promise<EmployerRegistry> {
  const path = join(import.meta.dir, "../../../config/employer-registry.json");
  return JSON.parse(await readFile(path, "utf8")) as EmployerRegistry;
}
