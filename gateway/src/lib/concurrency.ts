// Order-preserving map with bounded concurrency.
//
// Used for the audience paths' relay-pool DO calls (cache writes, retry
// hand-offs, pending-claim reads): independent calls that ran one at a time
// but shouldn't all fire at once either. Relay publishing doesn't go through
// here; it is batched per relay (publish.ts fanOutBatch). Results come back in
// input order, whatever order they finish in.

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
