import { expect, test } from "bun:test";
import { availabilityPhase, availabilityText, prepareAvailabilityAnswer, parseIsoDate } from "../../packages/core/src/availability";

const input = { relocationDate: "2026-08-07", availableFrom: "2026-08-17" };

test("parseIsoDate accepts valid calendar dates and rejects malformed or impossible values", () => {
  expect(parseIsoDate("2026-08-07")).toBe(Date.UTC(2026, 7, 7));
  expect(parseIsoDate("2024-02-29")).toBe(Date.UTC(2024, 1, 29)); // real leap day
  expect(parseIsoDate(null)).toBeNull();
  expect(parseIsoDate("")).toBeNull();
  expect(parseIsoDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
  expect(parseIsoDate("2026-8-7")).toBeNull(); // not zero-padded
  expect(parseIsoDate("2026-13-01")).toBeNull(); // impossible month
  expect(parseIsoDate("2026-08-32")).toBeNull(); // impossible day
  expect(parseIsoDate("not-a-date")).toBeNull();
});

test("boundary: 2026-08-06 is before relocation", () => {
  expect(availabilityPhase(input, "2026-08-06")).toBe("before_relocation");
});

test("boundary: 2026-08-07 (relocation day) counts as relocated, still pending availability", () => {
  expect(availabilityPhase(input, "2026-08-07")).toBe("relocated_pending");
});

test("boundary: 2026-08-16 is relocated, still pending availability", () => {
  expect(availabilityPhase(input, "2026-08-16")).toBe("relocated_pending");
});

test("boundary: 2026-08-17 (available-from day) is available immediately", () => {
  expect(availabilityPhase(input, "2026-08-17")).toBe("available");
});

test("boundary: a later date is available immediately", () => {
  expect(availabilityPhase(input, "2026-10-15")).toBe("available");
  expect(availabilityPhase(input, "2027-01-01")).toBe("available");
});

test("English text matches the documented phases exactly", () => {
  expect(availabilityText(input, "2026-08-06", "en")).toBe("Relocating to Frankfurt/Rhine-Main on 7 August 2026; available from 17 August 2026.");
  expect(availabilityText(input, "2026-08-07", "en")).toBe("Based in Frankfurt/Rhine-Main; available from 17 August 2026.");
  expect(availabilityText(input, "2026-08-16", "en")).toBe("Based in Frankfurt/Rhine-Main; available from 17 August 2026.");
  expect(availabilityText(input, "2026-08-17", "en")).toBe("Based in Frankfurt/Rhine-Main; available immediately.");
  expect(availabilityText(input, "2026-10-15", "en")).toBe("Based in Frankfurt/Rhine-Main; available immediately.");
});

test("German text matches the documented phases exactly", () => {
  expect(availabilityText(input, "2026-08-06", "de")).toBe("Umzug in den Raum Frankfurt/Rhein-Main am 07.08.2026; verfügbar ab 17.08.2026.");
  expect(availabilityText(input, "2026-08-07", "de")).toBe("Im Raum Frankfurt/Rhein-Main wohnhaft; verfügbar ab 17.08.2026.");
  expect(availabilityText(input, "2026-08-16", "de")).toBe("Im Raum Frankfurt/Rhein-Main wohnhaft; verfügbar ab 17.08.2026.");
  expect(availabilityText(input, "2026-08-17", "de")).toBe("Im Raum Frankfurt/Rhein-Main wohnhaft; ab sofort verfügbar.");
  expect(availabilityText(input, "2026-10-15", "de")).toBe("Im Raum Frankfurt/Rhein-Main wohnhaft; ab sofort verfügbar.");
});

test("never republishes the historical availability date as if it were still in the future", () => {
  const later = availabilityText(input, "2026-10-15", "en");
  expect(later).not.toContain("17 August 2026");
  expect(later).not.toContain("available from");
  const laterDe = availabilityText(input, "2026-10-15", "de");
  expect(laterDe).not.toContain("17.08.2026");
  expect(laterDe).not.toContain("verfügbar ab");
});

test("does not publish ursprünglich / originally-since phrasing", () => {
  for (const locale of ["en", "de"] as const) {
    expect(availabilityText(input, "2026-10-15", locale).toLowerCase()).not.toContain("originally");
    expect(availabilityText(input, "2026-10-15", locale).toLowerCase()).not.toContain("ursprünglich");
  }
});

test("application answer reuses verified profile availability", () => {
  const profile = { availability: {
    relocation_date: { value: "2026-08-07", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
    available_from: { value: "2026-08-17", verification_status: "user_confirmed", provenance: [{ source_type: "user_statement", source_ref: "test" }] },
  } };
  expect(prepareAvailabilityAnswer(profile, "2026-08-17", "en")?.proposedValue).toBe("Based in Frankfurt/Rhine-Main; available immediately.");
  expect(prepareAvailabilityAnswer({ availability: { available_from: profile.availability.available_from } }, "2026-08-17", "en")).toBeNull();
});

test("rejects malformed asOfDate and availableFrom instead of silently guessing", () => {
  expect(() => availabilityPhase(input, "2026-13-40")).toThrow();
  expect(() => availabilityPhase({ relocationDate: "2026-08-07", availableFrom: "not-a-date" }, "2026-08-07")).toThrow();
});
