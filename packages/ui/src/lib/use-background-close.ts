import { terminalsApi } from "@trackwall/protocol";
import { useState } from "react";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";

/**
 * A Shell tab's "Close" without waiting (ADR-185): the shell's id is hidden at once and the daemon confirms its end in
 * the background (a shell that ignores the gentle stop takes the grace period). An end that is not confirmed shows it
 * again with the error.
 */
export function useBackgroundClose(conn: Connection, onClose: () => void) {
  // A confirmed close forgets the id for good, so it stays hidden for the tab's life.
  const [closing, setClosing] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const run = (id: string) => {
    setClosing((ids) => new Set(ids).add(id));
    setError(undefined);
    onClose();
    post(conn, terminalsApi.close, { terminal: id }).catch((err: unknown) => {
      setClosing((ids) => new Set([...ids].filter((closed) => closed !== id)));
      setError(`The shell did not close: ${errorMessage(err)}`);
    });
  };
  return { run, closing, error };
}
