const freehireEndpoint = process.env.FREEHIRE_TEST_ENDPOINT;
const jobsucheEndpoint = process.env.JOBSUCHE_TEST_ENDPOINT;
const failAts = process.env.ATS_TEST_FAILURE === "1";

if (!freehireEndpoint || !jobsucheEndpoint) {
  throw new Error("FREEHIRE_TEST_ENDPOINT and JOBSUCHE_TEST_ENDPOINT are required by the search-all CLI fixture");
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const requested = new URL(String(input));
  if (requested.hostname.endsWith(".jobs.personio.com") || requested.hostname.endsWith(".jobs.personio.de")) {
    return Promise.resolve(new Response("<workzag-jobs></workzag-jobs>", {
      headers: { "content-type": "application/xml" },
    }));
  }
  if (requested.origin === "https://boards-api.greenhouse.io") {
    if (failAts && requested.pathname.includes("/nlighten/")) {
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }
    return Promise.resolve(Response.json({ jobs: [] }));
  }
  if (requested.origin === "https://api.lever.co" || requested.origin === "https://api.eu.lever.co") {
    return Promise.resolve(Response.json([]));
  }
  if (requested.origin === "https://api.ashbyhq.com") {
    return Promise.resolve(Response.json({ jobs: [], apiVersion: "1" }));
  }
  if (requested.origin === "https://api.smartrecruiters.com") {
    return Promise.resolve(Response.json({ offset: 0, limit: 100, totalFound: 0, content: [] }));
  }
  if (requested.hostname.endsWith(".recruitee.com")) {
    return Promise.resolve(Response.json({ offers: [] }));
  }
  const endpoint = requested.origin === "https://freehire.dev"
    ? freehireEndpoint
    : requested.origin === "https://rest.arbeitsagentur.de"
      ? jobsucheEndpoint
      : null;
  if (!endpoint) throw new Error(`unexpected search-all origin: ${requested.origin}`);
  return realFetch(new URL(`${requested.pathname}${requested.search}`, endpoint), init);
}) as typeof fetch;

export {};
