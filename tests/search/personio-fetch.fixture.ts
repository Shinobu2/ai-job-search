const endpoint = process.env.PERSONIO_TEST_ENDPOINT;

if (!endpoint) throw new Error("PERSONIO_TEST_ENDPOINT is required by the Personio CLI fixture");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const requested = new URL(String(input));
  if (["https://maincubes-1.jobs.personio.com", "https://maincubes-1.jobs.personio.de"].includes(requested.origin)) {
    return realFetch(new URL(`${requested.pathname}${requested.search}`, endpoint), init);
  }
  if (requested.origin === "https://boards-api.greenhouse.io") return Promise.resolve(Response.json({ jobs: [] }));
  if (requested.origin === "https://api.lever.co") return Promise.resolve(Response.json([]));
  if (requested.origin === "https://api.ashbyhq.com") return Promise.resolve(Response.json({ jobs: [], apiVersion: "1" }));
  if (requested.origin === "https://api.smartrecruiters.com") {
    return Promise.resolve(Response.json({ offset: 0, limit: 100, totalFound: 0, content: [] }));
  }
  if (requested.hostname.endsWith(".recruitee.com")) return Promise.resolve(Response.json({ offers: [] }));
  throw new Error(`unexpected employer ATS origin: ${requested.origin}`);
}) as typeof fetch;

export {};
