import { workspaceApi } from "@trackwall/protocol";
import { useMemo } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useRemote } from "./use-remote.ts";

/** How often the window reads the workspace settings while no projects folder is set, and once one is. */
const FOLDER_UNSET_POLL_MS = 3000;
const FOLDER_SET_POLL_MS = 5 * 60_000;

/**
 * The projects folder (ADR-18) for the parts of the window that offer nothing without one, the supervisor's start card
 * and the Sessions view's form: `null` while none is set, `undefined` until the workspace settings are read, which keeps
 * what those parts offer rather than hide it on a slow answer. Read every 3 s while none is set, since it is set
 * elsewhere (Settings, a dropped folder) while those parts stay on screen, and every 5 minutes after, since only a hand
 * edit of `workspace.yaml` takes it away.
 */
export function useProjectsDir(conn: Connection | undefined): string | null | undefined {
  const load = useMemo(() => conn && (() => post(conn, workspaceApi.settings, {})), [conn]);
  const settings = useRemote(load, { pollMs: (data) => (data?.projectsDir === null ? FOLDER_UNSET_POLL_MS : FOLDER_SET_POLL_MS) });
  return settings.data?.projectsDir;
}
