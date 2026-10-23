import { useCallback, useEffect, useState } from "react";

export type Remote<T> = { kind: "loading" } | { kind: "ok"; data: T } | { kind: "error"; message: string };

/**
 * Dane z daemona dla jednego widoku: ładuje przy każdej zmianie `load` (zmień ją przez `useCallback`, gdy zmienia
 * się to, o co pytasz) i odrzuca odpowiedź, która przyszła po zmianie pytania.
 */
export function useRemote<T>(load: (() => Promise<T>) | undefined): { state: Remote<T>; reload: () => void } {
  const [state, setState] = useState<Remote<T>>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!load) return;
    let current = true;
    setState((prev) => (prev.kind === "ok" ? prev : { kind: "loading" }));
    load().then(
      (data) => current && setState({ kind: "ok", data }),
      (err: unknown) => current && setState({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      current = false;
    };
  }, [load, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { state, reload };
}
