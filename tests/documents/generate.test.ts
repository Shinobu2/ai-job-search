import { expect, test } from "bun:test";
import { generateDocumentPacket } from "../../packages/documents/src/generate";

test("generates truthful EN/DE drafts from mapped evidence and flags missing identity", () => {
  const packet = generateDocumentPacket({ title: "Data Center Technician", company: "Example DC", evaluation: { mappings: [{ status: "partial", evidenceIds: ["PC_HARDWARE"] }], gates: [{ status: "VERIFY", reason: "Shift unknown" }] }, workspace: { profile: {}, evidence: { records: [{ id: "PC_HARDWARE", kind: "hardware", statement: "Personal PC hardware experience reported by candidate.", reviewer_status: "unreviewed" }] } } });
  expect(packet.ready_for_submission).toBe(false);
  expect(packet.missing).toContain("profile.identity.name");
  expect(packet.english).toContain("PC_HARDWARE");
  expect(packet.german).toContain("PC_HARDWARE");
  expect(packet.english).not.toContain("professional data-center experience");
});
