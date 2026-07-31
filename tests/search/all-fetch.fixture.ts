const freehireEndpoint = process.env.FREEHIRE_TEST_ENDPOINT;
const jobsucheEndpoint = process.env.JOBSUCHE_TEST_ENDPOINT;

if (!freehireEndpoint || !jobsucheEndpoint) {
  throw new Error("FREEHIRE_TEST_ENDPOINT and JOBSUCHE_TEST_ENDPOINT are required by the search-all CLI fixture");
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const requested = new URL(String(input));
  const endpoint = requested.origin === "https://freehire.dev"
    ? freehireEndpoint
    : requested.origin === "https://rest.arbeitsagentur.de"
      ? jobsucheEndpoint
      : null;
  if (!endpoint) throw new Error(`unexpected search-all origin: ${requested.origin}`);
  return realFetch(new URL(`${requested.pathname}${requested.search}`, endpoint), init);
}) as typeof fetch;

export {};
