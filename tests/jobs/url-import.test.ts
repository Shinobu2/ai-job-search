import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../../packages/storage/src/database";
import { migrate } from "../../packages/storage/src/migrate";
import { StorageRepository } from "../../packages/storage/src/repository";
import {
  createUrlImportSession,
  extractJobPostingJsonLd,
  importVacancyFromUrl,
  robotsAllows,
} from "../../packages/jobs/src/url-import";

const fixtures = join(import.meta.dir, "../fixtures/url-import");

async function html(name: string): Promise<string> {
  return readFile(join(fixtures, name), "utf8");
}

function repository() {
  const db = openDatabase(":memory:");
  migrate(db);
  return { db, repository: new StorageRepository(db) };
}

test("maps a Greenhouse JobPosting without inventing fields", async () => {
  const mapped = extractJobPostingJsonLd(await html("greenhouse.html"));

  expect(mapped).toEqual({
    title: "Data Center Technician",
    company: "Greenhouse Fixture GmbH",
    location: {
      addressLocality: "Frankfurt am Main",
      addressRegion: "Hessen",
      addressCountry: "DE",
    },
    datePosted: "2026-07-20",
    validThrough: "2026-08-31T23:59:59+02:00",
    employmentType: ["FULL_TIME", "PERMANENT"],
    baseSalary: {
      amount: 52000,
      minValue: null,
      maxValue: null,
      unitText: "YEAR",
    },
    description: "Repair server hardware.\nDocument incidents accurately.",
    directApply: true,
    identifier: "GH-123",
  });
});

test("skips invalid JSON-LD and finds a JobPosting nested in arrays and @graph", async () => {
  const mapped = extractJobPostingJsonLd(await html("personio.html"));

  expect(mapped).toEqual({
    title: "IT Support Specialist",
    company: "Personio Fixture GmbH",
    location: {
      addressLocality: "Berlin",
      addressRegion: null,
      addressCountry: "Germany",
    },
    datePosted: null,
    validThrough: null,
    employmentType: "FULL_TIME",
    baseSalary: {
      amount: null,
      minValue: 45000,
      maxValue: 55000,
      unitText: "YEAR",
    },
    description: "Support users & maintain Windows devices.",
    directApply: false,
    identifier: "9876",
  });
});

test("imports JSON-LD and model fallback pages with explicit source markers", async () => {
  const fixture = repository();
  const pages = new Map([
    ["https://jobs.example.test/robots.txt", "User-agent: *\nDisallow:"],
    ["https://jobs.example.test/greenhouse/123", await html("greenhouse.html")],
    ["https://jobs.example.test/fallback/456", await html("no-json-ld.html")],
  ]);
  const requests: Array<{ url: string; userAgent: string | null; hasSignal: boolean }> = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    requests.push({
      url,
      userAgent: new Headers(init?.headers).get("user-agent"),
      hasSignal: init?.signal !== undefined && init.signal !== null,
    });
    const body = pages.get(url);
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200, headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "text/html" } });
  }) as unknown as typeof fetch;

  try {
    const structured = await importVacancyFromUrl(
      "https://jobs.example.test/greenhouse/123?utm_source=test#apply",
      fixture.repository,
      { fetcher },
    );
    const fallback = await importVacancyFromUrl(
      "https://jobs.example.test/fallback/456",
      fixture.repository,
      { fetcher },
    );
    const sources = fixture.db.query(`
      SELECT j.title, s.source_type AS sourceType, s.supplied_url AS suppliedUrl, s.raw_content AS rawContent
      FROM job_sources s
      JOIN jobs j ON j.source_id = s.id
      ORDER BY j.title
    `).all() as Array<{ title: string; sourceType: string; suppliedUrl: string; rawContent: string }>;

    expect(structured).toMatchObject({
      title: "Data Center Technician",
      company: "Greenhouse Fixture GmbH",
      location: "Frankfurt am Main, Hessen, DE",
      importSource: "json-ld",
    });
    expect(fallback).toMatchObject({
      title: "Fallback Support Technician",
      company: "Fallback Fixture GmbH",
      location: "Cologne, Germany",
      importSource: "model-fallback",
    });
    expect(sources.map(({ title, sourceType, suppliedUrl }) => ({ title, sourceType, suppliedUrl }))).toEqual([
      {
        title: "Data Center Technician",
        sourceType: "json-ld",
        suppliedUrl: "https://jobs.example.test/greenhouse/123",
      },
      {
        title: "Fallback Support Technician",
        sourceType: "model-fallback",
        suppliedUrl: "https://jobs.example.test/fallback/456",
      },
    ]);
    expect(sources[0].rawContent).toContain("Repair server hardware.");
    expect(sources[0].rawContent).not.toContain("<script");
    expect(sources[1].rawContent).toContain("Help colleagues with workplace hardware and software.");
    expect(sources[1].rawContent).not.toContain("Script content must not reach");
    expect(sources[1].rawContent).not.toContain("Hidden mandatory");
    expect(requests.map((request) => request.url)).toContain("https://jobs.example.test/greenhouse/123?utm_source=test#apply");
    expect(requests.map((request) => request.url)).toContain("https://jobs.example.test/fallback/456");
    expect(requests.every((request) => request.userAgent?.includes("Mozilla/5.0"))).toBe(true);
    expect(requests.every((request) => request.hasSignal)).toBe(true);
  } finally {
    fixture.db.close();
  }
});

test("uses cleaned model fallback text when every JSON-LD block is invalid", async () => {
  const fixture = repository();
  const page = [
    "<!doctype html>",
    "<html><head>",
    '<script type="application/ld+json">{ invalid JSON }</script>',
    "<script>window.noise = 'ignore me';</script>",
    "</head><body>",
    "<h1>Invalid JSON-LD Technician</h1>",
    "<p>Company: Resilient Fixture GmbH</p>",
    "<p>Location: Hamburg, Germany</p>",
    "</body></html>",
  ].join("");
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => String(input).endsWith("/robots.txt")
    ? new Response("User-agent: *\nDisallow:")
    : new Response(page)) as unknown as typeof fetch;

  try {
    const imported = await importVacancyFromUrl(
      "https://invalid.example.test/jobs/1",
      fixture.repository,
      { fetcher },
    );
    const stored = fixture.db.query(`
      SELECT s.source_type AS sourceType, s.raw_content AS rawContent
      FROM job_sources s
      JOIN jobs j ON j.source_id = s.id
      WHERE j.id = ?
    `).get(imported.id) as { sourceType: string; rawContent: string };

    expect(imported).toMatchObject({
      title: "Invalid JSON-LD Technician",
      company: "Resilient Fixture GmbH",
      location: "Hamburg, Germany",
      importSource: "model-fallback",
    });
    expect(stored.sourceType).toBe("model-fallback");
    expect(stored.rawContent).not.toContain("invalid JSON");
    expect(stored.rawContent).not.toContain("ignore me");
  } finally {
    fixture.db.close();
  }
});

test("refuses a robots-disallowed page before fetching it", async () => {
  const fixture = repository();
  const requested: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/robots.txt")) {
      return new Response([
        "User-agent: *",
        "Disallow: /private/",
        "Allow: /private/open/",
      ].join("\n"));
    }
    return new Response(await html("greenhouse.html"));
  }) as unknown as typeof fetch;

  try {
    expect(robotsAllows(
      "User-agent: *\nDisallow: /private/\nAllow: /private/open/",
      "CareerControlRoom",
      "/private/open/job",
    )).toBe(true);
    expect(robotsAllows(
      "User-agent: *\nDisallow: /private/\nAllow: /private/open/",
      "CareerControlRoom",
      "/private/job",
    )).toBe(false);
    expect(robotsAllows(
      "User-agent: Control\nDisallow: /private/job",
      "CareerControlRoom",
      "/private/job",
    )).toBe(true);
    await expect(importVacancyFromUrl(
      "https://blocked.example.test/private/job",
      fixture.repository,
      { fetcher },
    )).rejects.toThrow(/robots\.txt.*disallow|disallow.*robots\.txt/i);
    expect(requested).toEqual(["https://blocked.example.test/robots.txt"]);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 });
  } finally {
    fixture.db.close();
  }
});

test("continues with a warning when robots.txt fails over the network", async () => {
  const fixture = repository();
  const warnings: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith("/robots.txt")) throw new TypeError("DNS lookup failed");
    return new Response(await html("greenhouse.html"));
  }) as unknown as typeof fetch;

  try {
    const imported = await importVacancyFromUrl(
      "https://network-error.example.test/jobs/1",
      fixture.repository,
      { fetcher, warn: (message) => warnings.push(message) },
    );

    expect(imported.title).toBe("Data Center Technician");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/robots\.txt.*DNS lookup failed/i);
  } finally {
    fixture.db.close();
  }
});

test("continues with a warning when robots.txt returns 403 or 5xx", async () => {
  for (const status of [403, 503]) {
    const fixture = repository();
    const warnings: string[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => String(input).endsWith("/robots.txt")
      ? new Response("unavailable", { status })
      : new Response(await html("greenhouse.html"))) as unknown as typeof fetch;

    try {
      const imported = await importVacancyFromUrl(
        `https://robots-${status}.example.test/jobs/1`,
        fixture.repository,
        { fetcher, warn: (message) => warnings.push(message) },
      );

      expect(imported.title).toBe("Data Center Technician");
      expect(warnings).toEqual([
        expect.stringMatching(new RegExp(`robots\\.txt.*HTTP ${status}`, "i")),
      ]);
    } finally {
      fixture.db.close();
    }
  }
});

test("caches robots.txt by origin within one URL import session", async () => {
  const fixture = repository();
  const requests: string[] = [];
  let now = 0;
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return url.endsWith("/robots.txt")
      ? new Response("User-agent: *\nDisallow:")
      : new Response(await html("greenhouse.html"));
  }) as unknown as typeof fetch;
  const session = createUrlImportSession({
    fetcher,
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
  });

  try {
    await session.importVacancyFromUrl("https://cached.example.test/jobs/1", fixture.repository);
    await session.importVacancyFromUrl("https://cached.example.test/jobs/2", fixture.repository);

    expect(requests.filter((url) => url.endsWith("/robots.txt"))).toEqual([
      "https://cached.example.test/robots.txt",
    ]);
  } finally {
    fixture.db.close();
  }
});

test("paces same-host page requests by at least one second in one URL import session", async () => {
  const fixture = repository();
  const pageRequests: Array<{ url: string; at: number }> = [];
  const delays: number[] = [];
  let now = 10_000;
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:");
    pageRequests.push({ url, at: now });
    return new Response(await html("greenhouse.html"));
  }) as unknown as typeof fetch;
  const session = createUrlImportSession({
    fetcher,
    now: () => now,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
  });

  try {
    await session.importVacancyFromUrl("https://paced.example.test/jobs/1", fixture.repository);
    await session.importVacancyFromUrl("https://paced.example.test/jobs/2", fixture.repository);
    await session.importVacancyFromUrl("https://other.example.test/jobs/3", fixture.repository);

    expect(pageRequests).toEqual([
      { url: "https://paced.example.test/jobs/1", at: 11_000 },
      { url: "https://paced.example.test/jobs/2", at: 12_000 },
      { url: "https://other.example.test/jobs/3", at: 13_000 },
    ]);
    expect(delays).toEqual([1_000, 1_000, 1_000]);
  } finally {
    fixture.db.close();
  }
});
