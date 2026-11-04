import { type TerminalPlace, terminalsApi } from "@trackwall/protocol";
import { useCallback, useContext } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { FolderTerminalsLive, terminalAt } from "./folder-terminals.ts";
import { useRemote } from "./use-remote.ts";

/** Folder terminals come live from the events WebSocket; polled only while it is not connected. */
const TERMINALS_POLL_MS = 5000;

/** The place's folder terminal from the daemon's list: `loaded` once the list came, `terminal` when the place has one. */
export function useFolderTerminal(conn: Connection, place: TerminalPlace) {
  const live = useContext(FolderTerminalsLive);
  const load = useCallback(() => post(conn, terminalsApi.list, {}), [conn]);
  const remote = useRemote(load, { pollMs: TERMINALS_POLL_MS, live });
  return {
    loaded: remote.data !== undefined,
    terminal: remote.data && terminalAt(remote.data, place),
    error: remote.error,
    reload: remote.reload,
  };
}
