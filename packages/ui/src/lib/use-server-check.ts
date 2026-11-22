import { type ServerCheckState, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type RemoteOptions, useRemote } from "./use-remote.ts";

/** The server check's last round (ADR-295), from the daemon's memory: polling it starts no git. */
export function useServerCheck(conn: Connection, options: RemoteOptions<ServerCheckState>) {
  const load = useCallback(() => post(conn, workspaceApi.serverCheck, {}), [conn]);
  return useRemote(load, options);
}
