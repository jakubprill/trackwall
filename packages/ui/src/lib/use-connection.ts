import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api.ts";
import { type Connection, resolveConnection, retryConnection } from "./connection.ts";

export interface ConnectionHandle {
  conn?: Connection;
  /** Grows with every connection swap; views use it as `key` to start from a clean state. */
  epoch: number;
  /** The error of resolving the connection or of the last reconnection attempt. */
  error?: string;
  retry: () => void;
  /**
   * Asks for the connection again without restarting the daemon, for a page that outlives a daemon restart in another
   * window (the tray panel, ADR-50); a changed address or token replaces the connection.
   */
  refresh: () => void;
}

/**
 * One connection to the daemon for the whole UI. In the Tauri window `retry` starts the daemon again if it is not
 * running and swaps the connection (new port and token), and the views mount anew; in a browser the daemon is started by
 * hand, the connection stays, and the view that called `retry` fetches its data again itself.
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
