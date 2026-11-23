import { type DoctorReport, doctorApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

/**
 * The doctor's report for Settings (ADR-101, ADR-262): one run that "Get started" and "Diagnostics" both show, so the
 * steps, the line under "Get started" in the list and the list of checks never come from different runs. The doctor opens
 * connections and times file writes, so it runs only once `wanted` was true, and the report then stays while Settings
 * is open.
 */
export function useDoctorReport(conn: Connection, wanted: boolean): RemoteHandle<DoctorReport> {
  const [asked, setAsked] = useState(wanted);
  if (wanted && !asked) setAsked(true);
  const load = useCallback(() => post(conn, doctorApi.run, {}), [conn]);
  return useRemote(asked ? load : undefined);
}
