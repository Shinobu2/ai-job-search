/**
 * Adaptive availability text.
 *
 * Pure and timezone-safe: the caller injects `asOfDate` as a YYYY-MM-DD string.
 * Dates are compared as date-only UTC epochs so a local midnight roll-over cannot
 * flip the branch. Never publish the historical availability date once it has
 * passed; from `availableFrom` onward the text is "available immediately".
 */

export type AvailabilityLocale = "en" | "de";

export type AvailabilityPhase =
  /** Before the relocation date: still moving to the region. */
  | "before_relocation"
  /** On/after relocation but before the available-from date: local, not yet available. */
  | "relocated_pending"
  /** On/after the available-from date: available immediately. */
  | "available";

export type AvailabilityInput = {
  /** Verified relocation date in YYYY-MM-DD. */
  relocationDate: string;
  /** YYYY-MM-DD. Required: the date the candidate can start. */
  availableFrom: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a YYYY-MM-DD string to a UTC midnight epoch and validate the calendar
 * date (rejects 2026-13-40 etc.). Returns null for empty/invalid input.
 */
export function parseIsoDate(value: string | null | undefined): number | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const epoch = Date.UTC(year, month - 1, day);
  if (epoch !== Date.UTC(year, month - 1, day)) return null;
  if (new Date(epoch).getUTCFullYear() !== year) return null;
  if (new Date(epoch).getUTCMonth() !== month - 1) return null;
  if (new Date(epoch).getUTCDate() !== day) return null;
  return epoch;
}

function requireIsoDate(value: string, field: string): number {
  const epoch = parseIsoDate(value);
  if (epoch === null) throw new Error(`availability: ${field} must be a valid YYYY-MM-DD date, got "${value}"`);
  return epoch;
}

/**
 * Classify which availability phase `asOfDate` falls into. Boundary semantics:
 * the relocation day counts as already relocated, and the available-from day
 * counts as available.
 */
export function availabilityPhase(input: AvailabilityInput, asOfDate: string): AvailabilityPhase {
  const asOf = requireIsoDate(asOfDate, "asOfDate");
  const availableFrom = requireIsoDate(input.availableFrom, "availableFrom");
  const relocation = requireIsoDate(input.relocationDate, "relocationDate");
  if (relocation > availableFrom) throw new Error("availability: relocationDate must not be after availableFrom");
  if (asOf < relocation) return "before_relocation";
  if (asOf < availableFrom) return "relocated_pending";
  return "available";
}

function regionLabel(locale: AvailabilityLocale): string {
  return locale === "en" ? "Frankfurt/Rhine-Main" : "Frankfurt/Rhein-Main";
}

const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** English long form, e.g. "7 August 2026" (no leading zero on the day). */
function formatEn(iso: string): string {
  const epoch = requireIsoDate(iso, "date");
  const d = new Date(epoch);
  return `${d.getUTCDate()} ${EN_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** German numeric form, e.g. "07.08.2026". */
function formatDe(iso: string): string {
  const epoch = requireIsoDate(iso, "date");
  const d = new Date(epoch);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

/**
 * Adaptive availability sentence for a cover letter / CV / form answer.
 * The historical date is never republished as if it were still in the future.
 */
export function availabilityText(input: AvailabilityInput, asOfDate: string, locale: AvailabilityLocale): string {
  const region = regionLabel(locale);
  const phase = availabilityPhase(input, asOfDate);
  const availableDisplay = locale === "en" ? formatEn(input.availableFrom) : formatDe(input.availableFrom);
  const relocationDisplay = locale === "en" ? formatEn(input.relocationDate) : formatDe(input.relocationDate);

  if (locale === "en") {
    switch (phase) {
      case "before_relocation":
        return `Relocating to ${region} on ${relocationDisplay}; available from ${availableDisplay}.`;
      case "relocated_pending":
        return `Based in ${region}; available from ${availableDisplay}.`;
      case "available":
        return `Based in ${region}; available immediately.`;
    }
  }
  switch (phase) {
    case "before_relocation":
      return `Umzug in den Raum ${region} am ${relocationDisplay}; verfügbar ab ${availableDisplay}.`;
    case "relocated_pending":
      return `Im Raum ${region} wohnhaft; verfügbar ab ${availableDisplay}.`;
    case "available":
      return `Im Raum ${region} wohnhaft; ab sofort verfügbar.`;
  }
}

type VerifiedDate = {
  value?: unknown;
  verification_status?: unknown;
  provenance?: Array<{ source_type?: unknown; source_ref?: unknown }>;
};

function verifiedDate(field: VerifiedDate | undefined): string | null {
  if (!["user_confirmed", "document_verified"].includes(String(field?.verification_status))) return null;
  if (typeof field?.value !== "string") return null;
  if (!field.provenance?.some((item) => item.source_type && item.source_ref)) return null;
  return field.value;
}

/** One evidence-safe profile adapter shared by documents and application answers. */
export function availabilityTextFromProfile(profile: Record<string, unknown>, asOfDate: string, locale: AvailabilityLocale): string | null {
  const availability = (profile.availability ?? {}) as { relocation_date?: VerifiedDate; available_from?: VerifiedDate };
  const relocationDate = verifiedDate(availability.relocation_date);
  const availableFrom = verifiedDate(availability.available_from);
  if (!relocationDate || !availableFrom) return null;
  return availabilityText({ relocationDate, availableFrom }, asOfDate, locale);
}

export function prepareAvailabilityAnswer(profile: Record<string, unknown>, asOfDate: string, locale: AvailabilityLocale) {
  const proposedValue = availabilityTextFromProfile(profile, asOfDate, locale);
  if (!proposedValue) return null;
  return {
    field: "availability",
    proposedValue,
    source: ["profile.availability.relocation_date", "profile.availability.available_from"],
    status: "known" as const,
    sensitive: false,
    lastConfirmedDate: null,
  };
}

/** Explicit timezone prevents UTC-midnight phase shifts in CLI generation. */
export function dateOnlyInTimeZone(value: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
