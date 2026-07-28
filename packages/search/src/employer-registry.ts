import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SearchTrack } from "./types";

export type EmployerPolicy = "public_ats_endpoint" | "manual_only";
export type EmployerRegistryEntry = {
  id: string;
  name: string;
  track: SearchTrack;
  cities: string[];
  career_url: string;
  ats: string;
  policy: EmployerPolicy;
  source_kind?: "employer" | "agency";
  content_language_fallback?: "de";
  enabled: boolean;
};
export type EmployerRegistry = { version: "employer-registry-v1"; cities: string[]; employers: EmployerRegistryEntry[] };

export async function loadEmployerRegistry(): Promise<EmployerRegistry> {
  const path = join(import.meta.dir, "../../../config/employer-registry.json");
  return JSON.parse(await readFile(path, "utf8")) as EmployerRegistry;
}
