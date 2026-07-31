import { expect, test } from "bun:test";
import { searchProfileSummary } from "../../scripts/cli";

test("search profile summary prints only verified profile values", () => {
  expect(searchProfileSummary({
    availability: {
      available_from: {
        value: "2026-09-03",
        verification_status: "user_confirmed",
        provenance: [{ source_type: "user_statement", source_ref: "test" }],
      },
    },
    legal: {
      work_authorization: {
        value: {
          basis: "Example authorization",
          sponsorship_required: false,
          available_from: "2026-09-04",
        },
        verification_status: "document_verified",
        provenance: [{ source_type: "document", source_ref: "test" }],
      },
    },
  })).toBe("Available from: 2026-09-03 · Work authorization: Example authorization · Sponsorship required: no");
});

test("search profile summary omits absent and unverified values", () => {
  expect(searchProfileSummary({
    availability: {
      available_from: {
        value: "2026-09-03",
        verification_status: "unknown",
        provenance: [],
      },
    },
    legal: {
      work_authorization: {
        value: null,
        verification_status: "unknown",
        provenance: [],
      },
    },
  })).toBeNull();
});
