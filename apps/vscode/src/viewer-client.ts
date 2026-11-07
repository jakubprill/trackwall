import { ApiEnvelope, HEALTH_PATH, HealthResult, type ViewerSessionList, viewerApi } from "@trackwall/protocol";
import { loopbackRequest } from "./loopback-request.ts";
import { readViewerFile } from "./viewer-file.ts";

/**
 * One look at the daemon, as the side bar and the status bar show it. The token goes out only after `/api/health` on the
 * file's port answers with the file's daemon start, so a file left by a daemon that has ended does not send it to another
 * program that took the port by chance (ADR-161, ADR-221).
 */
export type ViewerRead =
  /** No `viewer.json`: Trackwall is not running here, or viewer access is off. */
  | { kind: "off" }
  /** A `viewer.json` that no running daemon of this start answers for, or that cannot be read. */
  | { kind: "unavailable"; reason: string }
  | { kind: "connected"; list: ViewerSessionList };

export async function readSessions(folder: string, request = loopbackRequest): Promise<ViewerRead> {
  const read = await readViewerFile(folder);
  if (read.kind === "missing") return { kind: "off" };
  if (read.kind === "invalid") return { kind: "unavailable", reason: read.reason };
  const { port, token, instance } = read.file;
  try {
    const health = HealthResult.safeParse(JSON.parse((await request(port, HEALTH_PATH, { method: "GET" })).body));
    if (!health.success || !health.data.ok || health.data.data.instance !== instance) {
      return { kind: "unavailable", reason: "Trackwall that wrote viewer.json is not running any more" };
    }
    const res = await request(port, viewerApi.sessions.path, { method: "POST", token, body: "{}" });
    const envelope = ApiEnvelope.safeParse(JSON.parse(res.body));
    if (!envelope.success) return { kind: "unavailable", reason: `Trackwall answered ${res.status} in an unknown shape` };
    if (!envelope.data.ok) return { kind: "unavailable", reason: envelope.data.error.message };
    const list = viewerApi.sessions.data.safeParse(envelope.data.data);
    return list.success
      ? { kind: "connected", list: list.data }
      : { kind: "unavailable", reason: "Trackwall sent a session list this extension does not know" };
  } catch (err) {
    // A refused connection is the usual case: Trackwall wrote the file and has stopped since.
    const refused = (err as NodeJS.ErrnoException).code === "ECONNREFUSED";
    return { kind: "unavailable", reason: refused ? "Trackwall is not running" : (err as Error).message };
  }
}
