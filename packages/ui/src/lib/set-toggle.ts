/** A copy of the set with the item added, or removed when it was there: a checkbox list in React state. */
export function toggle<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
}
