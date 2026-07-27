import { expect, test } from "bun:test";
import { prepareApplicationAnswerMatrix } from "../../packages/core/src/application-answers";

const verifiedDate = (value: string) => ({
  value, verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }],
});

test("answer matrix reuses adaptive availability and blocks sensitive or unknown mandatory fields", () => {
  const matrix = prepareApplicationAnswerMatrix({
    fields: [
      { field: "Start date", proposed_value: null, source_evidence: [], status: "ask", sensitive: false, last_confirmed_date: null, required: true, category: "availability" },
      { field: "Work authorization", proposed_value: "Yes", source_evidence: ["guess"], status: "known", sensitive: false, last_confirmed_date: null, required: true, category: "work_authorization" },
      { field: "Salary", proposed_value: "€50,000", source_evidence: ["profile.compensation"], status: "known", sensitive: false, last_confirmed_date: null, required: true, category: "salary" },
    ],
    page_blockers: ["captcha"],
  }, { availability: { relocation_date: verifiedDate("2026-08-07"), available_from: verifiedDate("2026-08-17") } }, "2026-08-18", "en");

  expect(matrix.fields[0]).toMatchObject({ proposed_value: "Based in Frankfurt/Rhine-Main; available immediately.", status: "known" });
  expect(matrix.fields[1]).toMatchObject({ proposed_value: null, status: "user_decision", sensitive: true });
  expect(matrix.fields[2]).toMatchObject({ proposed_value: null, status: "user_decision", sensitive: true });
  expect(matrix.blockers).toEqual(expect.arrayContaining([
    expect.stringContaining("Work authorization"),
    expect.stringContaining("Salary"),
    expect.stringContaining("captcha"),
  ]));
  expect(matrix.submit_authorized).toBe(false);
});

test("answer matrix rejects impossible confirmation dates", () => {
  expect(() => prepareApplicationAnswerMatrix({
    fields: [
      { field: "Email", proposed_value: "candidate@example.com", source_evidence: ["profile.identity.email"], status: "known", sensitive: false, last_confirmed_date: "2026-99-99", required: true, category: "contact" },
    ],
  }, {}, "2026-07-26", "en")).toThrow("valid YYYY-MM-DD");
});

test("answer matrix downgrades whitespace-only known answers and evidence", () => {
  const matrix = prepareApplicationAnswerMatrix({
    fields: [
      { field: "Email", proposed_value: "   ", source_evidence: ["  "], status: "known", sensitive: false, last_confirmed_date: null, required: true, category: "contact" },
    ],
  }, {}, "2026-07-26", "en");
  expect(matrix.fields[0]).toMatchObject({ status: "ask", proposed_value: null, source_evidence: [] });
  expect(matrix.blockers).toContain("Email: required answer is not confirmed");
});
