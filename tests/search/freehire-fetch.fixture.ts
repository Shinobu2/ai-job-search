const endpoint = process.env.FREEHIRE_TEST_ENDPOINT;

if (!endpoint) throw new Error("FREEHIRE_TEST_ENDPOINT is required by the FreeHire CLI fixture");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const requested = new URL(String(input));
  if (requested.origin !== "https://freehire.dev") {
    throw new Error(`unexpected FreeHire origin: ${requested.origin}`);
  }
  return realFetch(new URL(`${requested.pathname}${requested.search}`, endpoint), init);
}) as typeof fetch;
