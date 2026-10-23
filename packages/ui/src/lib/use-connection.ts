import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api.ts";
import { type Connection, resolveConnection, retryConnection } from "./connection.ts";

export interface ConnectionHandle {
  conn?: Connection;
  /** Rośnie przy każdej próbie ponownego połączenia; widoki używają go jako `key`, żeby zacząć od czystego stanu. */
  epoch: number;
  /** Błąd ustalenia połączenia albo ostatniej próby ponownego połączenia. */
  error?: string;
  retry: () => void;
}

/**
 * Jedno połączenie z daemonem dla całego UI. `retry` w oknie Tauri uruchamia daemon ponownie, jeśli nie działa,
 * i podmienia połączenie (nowy port i token); w przeglądarce daemon uruchamia się ręcznie i połączenie zostaje.
 * W obu przypadkach widoki montują się od nowa i pobierają dane.
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
        if (next) setConn(next);
        setEpoch((e) => e + 1);
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, []);

  return { conn, epoch, error, retry };
}
