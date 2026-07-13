const endpoint = process.env.PERSONIO_TEST_ENDPOINT;

if (!endpoint) throw new Error("PERSONIO_TEST_ENDPOINT is required by the Personio CLI fixture");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const requested = new URL(String(input));
  if (requested.origin !== "https://maincubes-1.jobs.personio.de") {
    throw new Error(`unexpected Personio origin: ${requested.origin}`);
  }
  return realFetch(new URL(`${requested.pathname}${requested.search}`, endpoint), init);
}) as typeof fetch;

export {};
