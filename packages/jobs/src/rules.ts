import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedJob, Gate, GateStatus } from "./types";

type Taxonomy = {
  version: string;
  forced_x_cues: string[];
  facilities_cues: string[];
  trainee_cues: string[];
  hardware_cues: string[];
  support_cues: string[];
};

type EvaluationRules = {
  version: string;
  mapping_credits: Record<"proven" | "partial" | "transferable" | "missing" | "unknown" | "contradicted", number>;
  requirement_weight: number;
  salary_floor_eur: number;
  tier_bands: { S: number; A: number; B: number };
  gate_order: string[];
  evaluator_version: string;
};

export const taxonomy = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/role-taxonomy.json"), "utf8")) as Taxonomy;
export const evaluationRules = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/evaluation-rules.json"), "utf8")) as EvaluationRules;

function textOf(extracted: ExtractedJob): string {
  return Object.values(extracted.fields).map((field) => field.value ?? "").join(" ").toLowerCase();
}

function includesAny(text: string, cues: string[]): boolean {
  return cues.some((cue) => text.includes(cue));
}

export function classify(extracted: ExtractedJob): "A" | "AT" | "BT" | "F" | "X" {
  const text = textOf(extracted);
  if (includesAny(text, taxonomy.forced_x_cues)) return "X";
  const facilities = includesAny(text, taxonomy.facilities_cues);
  const trainee = includesAny(text, taxonomy.trainee_cues);
  if (!facilities && trainee && (includesAny(text, taxonomy.hardware_cues) || includesAny(text, taxonomy.support_cues))) return "AT";
  if (facilities && trainee) return "BT";
  if (facilities) return "X";
  if (includesAny(text, taxonomy.hardware_cues)) return "A";
  if (includesAny(text, taxonomy.support_cues)) return "F";
  return "X";
}

export function gate(id: string, status: GateStatus, critical: boolean, reason: string, facts: string[] = []): Gate {
  return { id, status, critical, reason, facts };
}
