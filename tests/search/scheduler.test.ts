import { expect, test } from "bun:test";
import { mapBounded, roundRobinScopes } from "../../packages/search/src/scheduler";

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
