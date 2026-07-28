import { expect, test } from "bun:test";
import { generateDocumentPacket } from "../../packages/documents/src/generate";

const verifiedIdentity = {
  name: { value: "Candidate", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
  email: { value: "candidate@example.com", verification_status: "document_verified", provenance: [{ source_type: "document", source_ref: "test" }] },
  phone: { value: "+49000", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
};

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
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "VERIFY", tier: "B", mappings: [{ status: "partial", evidenceIds: ["CONFIRMED", "UNREVIEWED"] }], gates: [] }, workspace: { profile: { identity: verifiedIdentity }, evidence: { records: [
    { id: "CONFIRMED", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
    { id: "UNREVIEWED", kind: "hardware", statement: "Unreviewed claim.", reviewer_status: "unreviewed" },
  ] } } });
  expect(packet.english).toContain("[CONFIRMED]");
  expect(packet.english).not.toContain("[UNREVIEWED]");
  expect(packet.ready_for_submission).toBe(true);
});

test("excludes confirmed document evidence without valid provenance", () => {
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "PROCEED", tier: "A", mappings: [{ status: "proven", evidenceIds: ["STATUS_ONLY"] }], gates: [] }, workspace: { profile: { identity: verifiedIdentity }, evidence: { records: [
    { id: "STATUS_ONLY", kind: "hardware", statement: "Status-only hardware claim.", reviewer_status: "user_confirmed", provenance: [] },
  ] } } });

  expect(packet.english).not.toContain("[STATUS_ONLY]");
  expect(packet.ready_for_submission).toBe(false);
  expect(packet.missing).toContain("evidence.mapped_role_evidence");
});

test("never marks blocked or critical-unknown document packets submission-ready", () => {
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "BLOCKED", tier: "C", mappings: [{ status: "partial", evidenceIds: ["PC_HARDWARE"] }], gates: [{ status: "VERIFY", critical: true, reason: "Night rotation unknown" }] }, workspace: { profile: { identity: verifiedIdentity }, evidence: { records: [{ id: "PC_HARDWARE", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "unreviewed" }] } } });
  expect(packet.ready_for_submission).toBe(false);
  expect(packet.missing).toContain("evaluation.non_blocked_match");
  expect(packet.missing).toContain("evaluation.critical_conditions_verified");
});

test("does not block a truthful document packet only because a deterministic tier is C", () => {
  const packet = generateDocumentPacket({
    title: "Technician",
    company: "Example",
    evaluation: { verdict: "PROCEED", tier: "C", mappings: [{ status: "partial", evidenceIds: ["CONFIRMED"] }], gates: [] },
    workspace: {
      profile: { identity: verifiedIdentity },
      evidence: { records: [{
        id: "CONFIRMED",
        kind: "hands_on",
        statement: "Personal hardware experience.",
        reviewer_status: "user_confirmed",
        provenance: [{ source_type: "user_statement", source_ref: "test" }],
      }] },
    },
  });

  expect(packet.ready_for_submission).toBe(true);
  expect(packet.missing).not.toContain("evaluation.non_blocked_match");
});

test("requires verified identity values with provenance before submission", () => {
  const identity = {
    ...verifiedIdentity,
    email: { value: "candidate@example.com", verification_status: "unknown", provenance: [] },
  };
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "PROCEED", tier: "A", mappings: [{ status: "proven", evidenceIds: ["CONFIRMED"] }], gates: [] }, workspace: { profile: { identity }, evidence: { records: [
    { id: "CONFIRMED", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "user_confirmed" },
  ] } } });

  expect(packet.ready_for_submission).toBe(false);
  expect(packet.missing).toContain("profile.identity.email");
});

const profileWithAvailability = {
  identity: verifiedIdentity,
  availability: {
    relocation_date: { value: "2026-08-07", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
    available_from: { value: "2026-08-17", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
  },
  locations: { city: { value: { name: "Frankfurt" }, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] } },
};

const profileWithPlannedAuthorization = {
  ...profileWithAvailability,
  legal: {
    work_authorization: {
      value: {
        status: "planned_after_arrival",
        basis: "§24 AufenthG (temporary protection)",
        employment_access: "full_once_issued",
        sponsorship_required: false,
        available_from: "2026-08-17",
      },
      verification_status: "user_confirmed",
      provenance: [{ source_type: "user_statement", source_ref: "test" }],
    },
  },
};

test("injects adaptive availability into cover-letter drafts when asOfDate and verified dates are present", () => {
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "PROCEED", tier: "A", mappings: [{ status: "proven", evidenceIds: ["CONFIRMED"] }], gates: [] }, workspace: { profile: profileWithAvailability, evidence: { records: [
    { id: "CONFIRMED", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
  ] } }, asOfDate: "2026-08-06" });
  expect(packet.availabilityTextEn).toBe("Relocating to Frankfurt/Rhine-Main on 7 August 2026; available from 17 August 2026.");
  expect(packet.availabilityTextDe).toBe("Umzug in den Raum Frankfurt/Rhein-Main am 07.08.2026; verfügbar ab 17.08.2026.");
  expect(packet.englishCoverLetter).toContain("Relocating to Frankfurt/Rhine-Main");
  expect(packet.germanCoverLetter).toContain("Umzug in den Raum Frankfurt/Rhein-Main");
});

test("switches to available-immediately once the available-from date has passed", () => {
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "PROCEED", tier: "A", mappings: [{ status: "proven", evidenceIds: ["CONFIRMED"] }], gates: [] }, workspace: { profile: profileWithAvailability, evidence: { records: [
    { id: "CONFIRMED", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
  ] } }, asOfDate: "2026-10-15" });
  expect(packet.availabilityTextEn).toBe("Based in Frankfurt/Rhine-Main; available immediately.");
  expect(packet.englishCoverLetter).not.toContain("17 August 2026");
});

test("omits adaptive availability when asOfDate is absent, preserving prior behavior", () => {
  const packet = generateDocumentPacket({ title: "Technician", company: "Example", evaluation: { verdict: "PROCEED", tier: "A", mappings: [{ status: "proven", evidenceIds: ["CONFIRMED"] }], gates: [] }, workspace: { profile: profileWithAvailability, evidence: { records: [
    { id: "CONFIRMED", kind: "hardware", statement: "Personal hardware experience.", reviewer_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
  ] } } });
  expect(packet.availabilityTextEn).toBeNull();
  expect(packet.availabilityTextDe).toBeNull();
  expect(packet.englishCoverLetter).not.toContain("available from");
});

test("uses exact planned §24 wording and includes its availability only once per document", () => {
  const packet = generateDocumentPacket({
    title: "Technician",
    company: "Example",
    evaluation: { verdict: "PROCEED", tier: "A", mappings: [{ status: "proven", evidenceIds: ["CONFIRMED"] }], gates: [] },
    workspace: {
      profile: profileWithPlannedAuthorization,
      evidence: { records: [{
        id: "CONFIRMED",
        kind: "hands_on",
        statement: "Personal hardware experience.",
        reviewer_status: "user_confirmed",
        provenance: [{ source_type: "user_statement", source_ref: "test" }],
      }] },
    },
    asOfDate: "2026-07-28",
  });
  const exactEn = "I am relocating to Frankfurt am Main on 7 August 2026 and will hold a residence permit under §24 AufenthG (temporary protection), which includes full access to the German labour market — no employer sponsorship is required. I am available to start from 17 August 2026.";
  const exactDe = "Ich ziehe am 7. August 2026 nach Frankfurt am Main und erhalte eine Aufenthaltserlaubnis nach §24 AufenthG, die eine uneingeschränkte Erwerbstätigkeit erlaubt — ein Sponsoring durch den Arbeitgeber ist nicht erforderlich. Ich kann ab dem 17. August 2026 beginnen.";

  expect(packet.englishCv.match(/I am relocating to Frankfurt am Main/g)).toHaveLength(1);
  expect(packet.germanCv.match(/Ich ziehe am 7\. August 2026/g)).toHaveLength(1);
  expect(packet.englishCoverLetter.match(/17 August 2026/g)).toHaveLength(1);
  expect(packet.germanCoverLetter.match(/17\. August 2026/g)).toHaveLength(1);
  expect(packet.englishCv).toContain(exactEn);
  expect(packet.germanCv).toContain(exactDe);
  expect(packet.atsDocument).toMatchObject({ workAuthorization: exactEn, availability: null });
});
