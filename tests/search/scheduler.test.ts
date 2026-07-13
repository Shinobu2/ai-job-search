import { expect, test } from "bun:test";
import { fetchWithRetry, mapBounded, roundRobinScopes } from "../../packages/search/src/scheduler";

test("roundRobinScopes returns the stable keyword-by-city cross product", () => {
  expect(roundRobinScopes(["network", "data center"], ["Frankfurt", "Eschborn"])).toEqual([
    { keyword: "network", city: "Frankfurt" },
    { keyword: "network", city: "Eschborn" },
    { keyword: "data center", city: "Frankfurt" },
    { keyword: "data center", city: "Eschborn" },
  ]);
  expect(roundRobinScopes([], ["Frankfurt"])).toEqual([]);
});

test("mapBounded preserves input order, caps concurrency at five, and settles sibling failures", async () => {
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const work = mapBounded(Array.from({ length: 8 }, (_, index) => index), 5, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    if (value === 2) throw new Error("fixture failure");
    return value * 2;
  });

  await Bun.sleep(0);
  expect(active).toBe(5);
  while (releases.length) {
    releases.shift()?.();
    await Bun.sleep(0);
  }
  const settled = await work;

  expect(maximum).toBe(5);
  expect(settled.map((entry) => entry.status)).toEqual([
    "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled",
  ]);
  expect(settled[0]).toEqual({ status: "fulfilled", value: 0 });
  expect(settled[7]).toEqual({ status: "fulfilled", value: 14 });
});

test("mapBounded rejects invalid concurrency and accepts empty input", async () => {
  await expect(mapBounded([], 1, async () => 1)).resolves.toEqual([]);
  await expect(mapBounded([1], 0, async (value) => value)).rejects.toThrow("concurrency");
  await expect(mapBounded([1], 6, async (value) => value)).rejects.toThrow("concurrency");
});

test("fetchWithRetry cancels transient response bodies before retrying", async () => {
  let attempts = 0;
  let cancellations = 0;
  const fetcher = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(new ReadableStream({ cancel() { cancellations += 1; } }), { status: 503 });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const response = await fetchWithRetry("https://example.test/read", {}, { sleep: async () => {} }, fetcher);
  expect(await response.text()).toBe("ok");
  expect(attempts).toBe(2);
  expect(cancellations).toBe(1);
});

test("fetchWithRetry treats response cleanup as best-effort", async () => {
  let attempts = 0;
  const fetcher = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(new ReadableStream({ cancel() { return Promise.reject(new Error("cleanup failed")); } }), { status: 503 });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const response = await fetchWithRetry("https://example.test/read", {}, { sleep: async () => {} }, fetcher);
  expect(await response.text()).toBe("ok");
  expect(attempts).toBe(2);
});

test("fetchWithRetry cancels the terminal retryable response before throwing its HTTP failure", async () => {
  let attempts = 0;
  let cancellations = 0;
  const fetcher = (async () => {
    attempts += 1;
    return new Response(new ReadableStream({ cancel() { cancellations += 1; } }), { status: 503 });
  }) as unknown as typeof fetch;

  await expect(fetchWithRetry("https://example.test/read", {}, { sleep: async () => {} }, fetcher)).rejects.toMatchObject({ code: "http_503" });
  expect(attempts).toBe(3);
  expect(cancellations).toBe(3);
});
