import { DAEMON_INFO_PATH, DaemonInfo } from "@trackwall/protocol";
import { useCallback, useEffect, useState } from "react";
import { call, errorCode, errorMessage } from "./api.ts";
import { inDesktopShell } from "./app-window.ts";
import {
  type Connection,
  forgetToken,
  resolveConnection,
  retryConnection,
  saveToken,
  tokenFromAddress,
  tokenStorage,
} from "./connection.ts";

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
  /**
   * In a browser: the daemon refused the page's token (none was given, or it is from before the daemon restarted), so
   * the page asks for its address instead of showing views that all fail (ADR-161).
   */
  tokenRefused: boolean;
  /** Takes the token from a pasted page address; rejects when there is none or the daemon does not accept it either. */
  connectWithAddress: (address: string) => Promise<void>;
}

const NEW_TOKEN_REFUSED =
  "Trackwall did not accept this token. It gets a new one every time it starts: print the address again and paste the new one.";

/**
 * Whether the daemon refuses this page's token. Only a browser page asks: the desktop shell gets the token from the daemon
 * it started or connected to. Any other failure is not about the token, so the views go on and show it themselves.
 */
async function refusesToken(conn: Connection): Promise<boolean> {
  if (inDesktopShell()) return false;
  try {
    await call(conn, DAEMON_INFO_PATH, DaemonInfo);
    return false;
  } catch (err) {
    return errorCode(err) === "unauthorized";
  }
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
  const [tokenRefused, setTokenRefused] = useState(false);

  useEffect(() => {
    resolveConnection()
      .then(async (next) => {
        if (!(await refusesToken(next))) return setConn(next);
        forgetToken(tokenStorage());
        setTokenRefused(true);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  const connectWithAddress = useCallback(async (address: string) => {
    const next = { baseUrl: "", token: tokenFromAddress(address) };
    if (await refusesToken(next)) throw new Error(NEW_TOKEN_REFUSED);
    saveToken(tokenStorage(), next.token);
    setTokenRefused(false);
    setConn(next);
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

  return { conn, epoch, error, retry, refresh, tokenRefused, connectWithAddress };
}
