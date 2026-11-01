import { type UnpushedWork, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type RemoteOptions, useRemote } from "./use-remote.ts";

/** The work on no remote across the projects folder (ADR-162); the daemon reads git only when it runs in a container. */
export function useUnpushedWork(conn: Connection, options: RemoteOptions<UnpushedWork>) {
  const load = useCallback(() => post(conn, workspaceApi.unpushedWork, {}), [conn]);
  return useRemote(load, options);
}
