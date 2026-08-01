import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_ATS_TYPES } from "./ats";
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

const employerRegistrySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "cities", "employers"],
  properties: {
    version: { const: "employer-registry-v1" },
    cities: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    employers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "track", "cities", "career_url", "ats", "policy", "enabled"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          track: { type: "string", minLength: 1 },
          cities: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          career_url: { type: "string", minLength: 1 },
          ats: { type: "string", minLength: 1 },
          policy: { enum: ["public_ats_endpoint", "manual_only"] },
          source_kind: { enum: ["employer", "agency"] },
          content_language_fallback: { const: "de" },
          enabled: { type: "boolean" },
        },
        allOf: [
          {
            if: {
              required: ["policy"],
              properties: { policy: { const: "public_ats_endpoint" } },
            },
            then: {
              properties: { ats: { enum: [...PUBLIC_ATS_TYPES] } },
            },
          },
        ],
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(employerRegistrySchema);

function duplicateIdViolations(value: unknown): string[] {
  if (value === null || typeof value !== "object" || !("employers" in value)) return [];
  const employers = (value as { employers?: unknown }).employers;
  if (!Array.isArray(employers)) return [];

  const seen = new Set<string>();
  const violations: string[] = [];
  for (const [index, employer] of employers.entries()) {
    if (employer === null || typeof employer !== "object" || !("id" in employer)) continue;
    const id = (employer as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) violations.push(`/employers/${index}/id duplicate employer id "${id}"`);
    else seen.add(id);
  }
  return violations;
}

export function validateEmployerRegistry(value: unknown): asserts value is EmployerRegistry {
  const valid = validateSchema(value);
  const violations = (validateSchema.errors ?? []).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
  violations.push(...duplicateIdViolations(value));
  if (!valid || violations.length > 0) {
    throw new Error(`Invalid employer registry:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
  }
}

export async function loadEmployerRegistry(): Promise<EmployerRegistry> {
  const path = join(import.meta.dir, "../../../config/employer-registry.json");
  const registry: unknown = JSON.parse(await readFile(path, "utf8"));
  validateEmployerRegistry(registry);
  return registry;
}
