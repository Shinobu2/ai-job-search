import { expect, test } from "bun:test";
import { generateDocumentPacket } from "../../packages/documents/src/generate";

test("generates truthful EN/DE drafts from mapped evidence and flags missing identity", () => {
  const packet = generateDocumentPacket({ title: "Data Center Technician", company: "Example DC", evaluation: { mappings: [{ status: "partial", evidenceIds: ["PC_HARDWARE"] }], gates: [{ status: "VERIFY", reason: "Shift unknown" }] }, workspace: { profile: {}, evidence: { records: [{ id: "PC_HARDWARE", kind: "hardware", statement: "Personal PC hardware experience reported by candidate.", reviewer_status: "unreviewed" }] } } });
  expect(packet.ready_for_submission).toBe(false);
  expect(packet.missing).toContain("profile.identity.name");
  expect(packet.missing).toContain("evidence.mapped_role_evidence");
  expect(packet.english).not.toContain("[PC_HARDWARE]");
  expect(packet.german).not.toContain("[PC_HARDWARE]");
  expect(packet.english).not.toContain("professional data-center experience");
});

test("uses only explicitly confirmed or document-verified evidence", () => {
  const identity = { name: { value: "Candidate" }, email: { value: "candidate@example.com" }, phone: { value: "+49000" } };
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "VERIFY", tier: "B", mappings: [{ status: "partial", evidenceIds: ["CONFIRMED", "UNREVIEWED"] }], gates: [] }, workspace: { profile: { identity }, evidence: { records: [
    { id: "CONFIRMED", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "user_confirmed" },
    { id: "UNREVIEWED", kind: "hardware", statement: "Unreviewed claim.", reviewer_status: "unreviewed" },
  ] } } });
  expect(packet.english).toContain("[CONFIRMED]");
  expect(packet.english).not.toContain("[UNREVIEWED]");
  expect(packet.ready_for_submission).toBe(true);
});

test("never marks blocked or critical-unknown document packets submission-ready", () => {
  const identity = { name: { value: "Candidate" }, email: { value: "candidate@example.com" }, phone: { value: "+49000" } };
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "BLOCKED", tier: "C", mappings: [{ status: "partial", evidenceIds: ["PC_HARDWARE"] }], gates: [{ status: "VERIFY", critical: true, reason: "Night rotation unknown" }] }, workspace: { profile: { identity }, evidence: { records: [{ id: "PC_HARDWARE", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "unreviewed" }] } } });
  expect(packet.ready_for_submission).toBe(false);
  expect(packet.missing).toContain("evaluation.non_blocked_match");
  expect(packet.missing).toContain("evaluation.critical_conditions_verified");
});
