import { expect, test } from "bun:test";
import {
  prepareApplicationAnswerMatrix,
  workAuthorizationWording,
} from "../../packages/core/src/application-answers";

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

const plannedAuthorizationProfile = {
  availability: {
    relocation_date: verifiedDate("2026-08-07"),
    available_from: verifiedDate("2026-08-17"),
  },
  legal: {
    work_authorization: verifiedDate({
      status: "planned_after_arrival",
      basis: "§24 AufenthG (temporary protection)",
      employment_access: "full_once_issued",
      sponsorship_required: false,
      available_from: "2026-08-17",
    } as never),
  },
};

test("planned §24 wording is exact and never claims the permit is already issued", () => {
  expect(workAuthorizationWording.en).toBe(
    "I am relocating to Frankfurt am Main on 7 August 2026 and will hold a residence permit under §24 AufenthG (temporary protection), which includes full access to the German labour market — no employer sponsorship is required. I am available to start from 17 August 2026.",
  );
  expect(workAuthorizationWording.de).toBe(
    "Ich ziehe am 7. August 2026 nach Frankfurt am Main und erhalte eine Aufenthaltserlaubnis nach §24 AufenthG, die eine uneingeschränkte Erwerbstätigkeit erlaubt — ein Sponsoring durch den Arbeitgeber ist nicht erforderlich. Ich kann ab dem 17. August 2026 beginnen.",
  );
  expect(workAuthorizationWording.en).not.toContain("already");
});

test("answer matrix safely answers §24 sponsorship and authorization questions", () => {
  const matrix = prepareApplicationAnswerMatrix({
    fields: [
      {
        field: "Will you now or in the future require sponsorship?",
        proposed_value: null,
        source_evidence: [],
        status: "ask",
        sensitive: false,
        last_confirmed_date: null,
        required: true,
        category: "work_authorization",
        question_intent: "sponsorship",
        comment_supported: false,
      },
      {
        field: "Are you authorized to work in Germany?",
        proposed_value: null,
        source_evidence: [],
        status: "ask",
        sensitive: false,
        last_confirmed_date: null,
        required: true,
        category: "work_authorization",
        question_intent: "authorized_to_work",
        comment_supported: true,
      },
      {
        field: "Authorized to work (yes/no only)",
        proposed_value: null,
        source_evidence: [],
        status: "ask",
        sensitive: false,
        last_confirmed_date: null,
        required: true,
        category: "work_authorization",
        question_intent: "authorized_to_work",
        comment_supported: false,
      },
    ],
  }, plannedAuthorizationProfile, "2026-07-28", "en");

  expect(matrix.fields[0]).toMatchObject({
    proposed_value: "No",
    status: "known",
    sensitive: false,
  });
  expect(matrix.fields[1]).toMatchObject({
    proposed_value: "Yes — available to start from 17 August 2026 under planned §24 authorization; no employer sponsorship required.",
    status: "known",
    sensitive: false,
  });
  expect(matrix.fields[2]).toMatchObject({
    proposed_value: null,
    status: "user_decision",
    sensitive: true,
  });
  expect(matrix.blockers).toContain("Authorized to work (yes/no only): explicit user decision required");
});
