import { useEffect, useState } from "react";

/** A value that follows `value` only after `ms` without changes: the search does not ask the repo host on every keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
