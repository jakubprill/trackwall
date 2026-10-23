import { useEffect, useState } from "react";

/** Wartość, która nadąża za `value` dopiero po `ms` bez zmian: wyszukiwanie nie pyta hostingu przy każdym znaku. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
