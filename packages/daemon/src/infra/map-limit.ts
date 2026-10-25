/** `Promise.all(items.map(fn))` with at most `limit` calls of `fn` at once; results in `items` order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!(limit >= 1)) throw new Error(`mapLimit: limit must be at least 1, got ${limit}`);
  const results: R[] = [];
  // One shared iterator: each free worker takes the next item, so a slow repo does not block the others.
  const pending = items.entries();
  const worker = async () => {
    for (const [i, item] of pending) results[i] = await fn(item, i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
