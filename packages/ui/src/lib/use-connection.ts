import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api.ts";
import { type Connection, resolveConnection, retryConnection } from "./connection.ts";

export interface ConnectionHandle {
  conn?: Connection;
  /** Rośnie przy każdej podmianie połączenia; widoki używają go jako `key`, żeby zacząć od czystego stanu. */
  epoch: number;
  error?: string;
  /** `true`, gdy połączenie zostało podmienione; wtedy widoki mają zacząć od nowa, inaczej wystarczy odświeżyć. */
  retry: () => Promise<boolean>;
}

/**
 * Jedno połączenie z daemonem dla całego UI. `retry` w oknie Tauri uruchamia daemon ponownie i podmienia
 * połączenie (nowy port i token); w przeglądarce daemon uruchamia się ręcznie i połączenie zostaje.
 */
export function useConnection(): ConnectionHandle {
  const [conn, setConn] = useState<Connection>();
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    resolveConnection().then(setConn, (err: unknown) => setError(errorMessage(err)));
  }, []);

  const retry = useCallback(async () => {
    const next = await retryConnection();
    if (!next) return false;
    setConn(next);
    setEpoch((e) => e + 1);
    setError(undefined);
    return true;
  }, []);

  return { conn, epoch, error, retry };
}
