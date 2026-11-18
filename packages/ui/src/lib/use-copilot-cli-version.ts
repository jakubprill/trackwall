import { type CopilotCliVersion, doctorApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type Remote, useRemote } from "./use-remote.ts";

/** Copilot CLI updates itself in the background, so its version is asked again every hour, not only on connecting. */
const COPILOT_VERSION_POLL_MS = 60 * 60 * 1000;

/** The version of the Copilot CLI sessions start, against the tested one (ADR-274); only `copilot --version` runs. */
export function useCopilotCliVersion(conn: Connection): Remote<CopilotCliVersion> {
  const load = useCallback(() => post(conn, doctorApi.copilotCliVersion, {}), [conn]);
  return useRemote(load, { pollMs: COPILOT_VERSION_POLL_MS });
}
