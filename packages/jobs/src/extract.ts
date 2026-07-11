import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedField, ExtractedJob, ExtractedRequirement } from "./types";

type LabelFieldRule = { id: string; label?: string; heading?: boolean; rule_id: string };
type DerivedFieldRule = { id: string; source: string; pattern: string; value: string; rule_id: string };
type RequirementRule = { field: string; type: string; separator: string; rule_id: string };
type Rules = { version: "extraction-v1"; fields: LabelFieldRule[]; derived_fields: DerivedFieldRule[]; requirements: RequirementRule[] };

const rules = JSON.parse(readFileSync(join(import.meta.dir, "../../../config/extraction-rules.json"), "utf8")) as Rules;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unknown(ruleId: string): ExtractedField {
  return { state: "unknown", value: null, spans: [], rule_ids: [ruleId] };
}

function known(value: string, start: number, ruleId: string): ExtractedField {
  return { state: "known", value, spans: [{ start, end: start + value.length }], rule_ids: [ruleId] };
}

function findValues(text: string, rule: LabelFieldRule): Array<{ value: string; start: number }> {
  if (rule.heading) {
    const match = /^#{1,6}\s+(.+)$/m.exec(text);
    return match && match.index !== undefined ? [{ value: match[1].trim(), start: match.index + match[0].indexOf(match[1]) }] : [];
  }
  const pattern = new RegExp(`^${escaped(rule.label as string)}\\s*:\\s*(.+)$`, "gim");
  return Array.from(text.matchAll(pattern)).map((match) => {
    const value = match[1].trim();
    return { value, start: (match.index ?? 0) + match[0].indexOf(match[1]) + match[1].indexOf(value) };
  });
}

function fieldFor(text: string, rule: LabelFieldRule): ExtractedField {
  const values = findValues(text, rule);
  if (values.length === 0) return unknown(rule.rule_id);
  const distinct = [...new Set(values.map(({ value }) => value))];
  if (distinct.length > 1) {
    return {
      state: "conflicting",
      value: null,
      spans: values.map(({ value, start }) => ({ start, end: start + value.length })),
      rule_ids: [rule.rule_id],
    };
  }
  return known(values[0].value, values[0].start, rule.rule_id);
}

function derivedField(fields: Record<string, ExtractedField>, rule: DerivedFieldRule): ExtractedField {
  const source = fields[rule.source];
  if (!source || source.state !== "known" || source.value === null) return unknown(rule.rule_id);
  const match = new RegExp(rule.pattern, "i").exec(source.value);
  if (!match || match.index === undefined) return unknown(rule.rule_id);
  const sourceSpan = source.spans[0];
  return {
    state: "known",
    value: rule.value,
    spans: [{ start: sourceSpan.start + match.index, end: sourceSpan.start + match.index + match[0].length }],
    rule_ids: [rule.rule_id],
  };
}

function requirementsFor(fields: Record<string, ExtractedField>, rules_: RequirementRule[]): ExtractedRequirement[] {
  return rules_.flatMap((rule) => {
    const field = fields[rule.field];
    if (!field || field.state !== "known" || field.value === null || field.spans.length === 0) return [];
    const value = field.value;
    let offset = 0;
    return value.split(rule.separator).flatMap((part) => {
      const text = part.trim();
      const index = value.indexOf(part, offset);
      offset = index + part.length;
      if (!text) return [];
      const normalized = text.toLowerCase().replace(/\s+/g, " ");
      const id = createHash("sha256").update(`${rule.type}:${normalized}`).digest("hex").slice(0, 16);
      const start = field.spans[0].start + index + part.indexOf(text);
      return [{ id: `requirement_${id}`, type: rule.type, text, spans: [{ start, end: start + text.length }], rule_ids: [rule.rule_id] }];
    });
  });
}

export function extractVacancy(text: string): ExtractedJob {
  const fields = Object.fromEntries(rules.fields.map((rule) => [rule.id, fieldFor(text, rule)])) as Record<string, ExtractedField>;
  for (const rule of rules.derived_fields) fields[rule.id] = derivedField(fields, rule);
  const requirements = requirementsFor(fields, rules.requirements);
  const uncertainties = Object.entries(fields).filter(([, field]) => field.state === "unknown").map(([id]) => id);
  return { version: rules.version, fields, requirements, uncertainties };
}
