import { expect, test } from "bun:test";
import { parseFlags } from "../../scripts/cli";

test("parseFlags preserves string values and parses bare boolean flags", () => {
  expect(parseFlags(
    ["--id", "job_123", "--confirm"],
    ["id", "confirm"],
    "applications set",
  )).toEqual({ id: "job_123", confirm: true });

  expect(parseFlags(
    ["--file", "vacancy.md", "--text", "inline"],
    ["file", "text"],
    "job import",
  )).toEqual({ file: "vacancy.md", text: "inline" });
});

test("parseFlags parses numeric flags and rejects non-numeric values", () => {
  expect(parseFlags(
    ["--limit", "12", "--dry-run"],
    ["limit", "dryRun"],
    "search freehire",
  )).toEqual({ limit: 12, dryRun: true });

  expect(() => parseFlags(
    ["--limit", "many"],
    ["limit"],
    "search freehire",
  )).toThrow("--limit requires a number");
});

test("parseFlags rejects duplicates and lists the command allowlist for unknown flags", () => {
  expect(() => parseFlags(
    ["--id", "job_1", "--id", "job_2"],
    ["id"],
    "job evaluate",
  )).toThrow("--id may only be provided once");

  expect(() => parseFlags(
    ["--status", "shortlisted"],
    ["file", "text"],
    "job import",
  )).toThrow("Unknown flag --status for job import. Allowed flags: --file, --text");
});
