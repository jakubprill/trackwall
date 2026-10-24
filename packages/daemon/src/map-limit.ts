/** `Promise.all(items.map(fn))` z najwyżej `limit` wywołaniami `fn` naraz; wyniki w kolejności `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!(limit >= 1)) throw new Error(`mapLimit: limit must be at least 1, got ${limit}`);
  const results: R[] = [];
  // Jeden wspólny iterator: każdy wolny wątek bierze następny element, więc wolne repo nie blokuje pozostałych.
  const pending = items.entries();
  const worker = async () => {
    for (const [i, item] of pending) results[i] = await fn(item, i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
