import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../concurrency";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns results in input order, whatever order they finish in", async () => {
    const out = await mapWithConcurrency([30, 5, 20, 1], 4, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  it("runs at most `limit` at once and every item exactly once", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 3, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await sleep(2);
      seen.push(n);
      inFlight--;
    });
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 8, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("rejects when an item throws", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("rejects a non-positive or fractional limit", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async (n) => n)).rejects.toThrow(RangeError);
  });
});
