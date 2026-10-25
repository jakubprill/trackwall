import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api.ts";
import { type Connection, resolveConnection, retryConnection } from "./connection.ts";

export interface ConnectionHandle {
  conn?: Connection;
  /** Rośnie przy każdej podmianie połączenia; widoki używają go jako `key`, żeby zacząć od czystego stanu. */
  epoch: number;
  /** Błąd ustalenia połączenia albo ostatniej próby ponownego połączenia. */
  error?: string;
  retry: () => void;
  /**
   * Asks for the connection again without restarting the daemon, for a page that outlives a daemon restart in another
   * window (the tray panel, ADR-50); a changed address or token replaces the connection.
   */
  refresh: () => void;
}

/**
 * Jedno połączenie z daemonem dla całego UI. `retry` w oknie Tauri uruchamia daemon ponownie, jeśli nie działa,
 * i podmienia połączenie (nowy port i token), a widoki montują się od nowa; w przeglądarce daemon uruchamia się
 * ręcznie, połączenie zostaje, a widok, który wywołał `retry`, sam pobiera dane ponownie.
 */
export function useConnection(): ConnectionHandle {
  const [conn, setConn] = useState<Connection>();
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    resolveConnection().then(setConn, (err: unknown) => setError(errorMessage(err)));
  }, []);

  const retry = useCallback(() => {
    setError(undefined);
    retryConnection().then(
      (next) => {
        if (!next) return;
        setConn(next);
        setEpoch((e) => e + 1);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  const refresh = useCallback(() => {
    resolveConnection().then(
      (next) => {
        setError(undefined);
        setConn((prev) => (prev?.baseUrl === next.baseUrl && prev.token === next.token ? prev : next));
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  return { conn, epoch, error, retry, refresh };
}
