import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { useMemo } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

/** How often the window reads the workspace settings while no projects folder is set, and once one is. */
const FOLDER_UNSET_POLL_MS = 3000;
const FOLDER_SET_POLL_MS = 5 * 60_000;

/**
 * The window's read of the workspace settings, for the parts of it that offer nothing without a projects folder (ADR-18):
 * the supervisor's start card, which keeps its starts until the settings are read (`projectsDir` is `undefined` until
 * then, `null` while none is set) rather than hide them on a slow answer; the Sessions view's form, which waits for that
 * first read; and the card above that form, which sets the folder with this read so that the form shows at once
 * (ADR-289). Read every 3 s while none is set, since it is also set elsewhere (Settings, a dropped folder) while those
 * parts stay on screen, and every 5 minutes after, since only a hand edit of `workspace.yaml` takes it away.
 */
export function useWorkspaceSettings(conn: Connection | undefined): RemoteHandle<WorkspaceSettings> {
  const load = useMemo(() => conn && (() => post(conn, workspaceApi.settings, {})), [conn]);
  return useRemote(load, { pollMs: (data) => (data?.projectsDir === null ? FOLDER_UNSET_POLL_MS : FOLDER_SET_POLL_MS) });
}
