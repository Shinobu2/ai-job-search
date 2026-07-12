const endpoint = process.env.JOBSUCHE_TEST_ENDPOINT;

if (!endpoint) throw new Error("JOBSUCHE_TEST_ENDPOINT is required by the Jobsuche CLI fixture");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const requested = new URL(String(input));
  if (requested.origin !== "https://rest.arbeitsagentur.de") {
    throw new Error(`unexpected Jobsuche origin: ${requested.origin}`);
  }
  return realFetch(new URL(`${requested.pathname}${requested.search}`, endpoint), init);
}) as typeof fetch;

export {};
