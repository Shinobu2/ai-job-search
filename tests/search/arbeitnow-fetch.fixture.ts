const endpoint = process.env.ARBEITNOW_TEST_ENDPOINT;

if (!endpoint) throw new Error("ARBEITNOW_TEST_ENDPOINT is required by the Arbeitnow CLI fixture");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const requested = new URL(String(input));
  if (requested.origin !== "https://www.arbeitnow.com") {
    throw new Error(`unexpected Arbeitnow origin: ${requested.origin}`);
  }
  return realFetch(new URL(`${requested.pathname}${requested.search}`, endpoint), init);
}) as typeof fetch;

export {};
