import type { Service, SliceMember } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/** A service state as a status label (ADR-45): ready is ok, waiting is a warning, a crash or a closed port is an error. */
export function serviceStateLabel(service: Service | null): { tone?: StatusTone; label: string } {
  if (!service) return { label: "not started" };
  const port = service.port === null ? "" : ` on port ${service.port}`;
  switch (service.state) {
    case "healthy":
      return { tone: "ok", label: `ready${port}` };
    case "starting":
      return { tone: "warning", label: "starting" };
    case "stopping":
      return { tone: "warning", label: "stopping" };
    case "stopped":
      return { label: "stopped" };
    case "unhealthy":
      return { tone: "error", label: "not answering" };
    case "crashed":
      return { tone: "error", label: "crashed" };
  }
}

/**
 * A dependency from the result of a start, with its service as it is now (`current`, from the list of services):
 * skipped with the reason, waiting while no service of it is known yet, otherwise its live state.
 */
export function memberLabel(member: SliceMember, current: Service | null): { tone?: StatusTone; label: string } {
  if (member.outcome === "skipped") return { label: `skipped: ${member.problem ?? ""}` };
  const service = current ?? member.service;
  if (!service) return { tone: "warning", label: "waiting for its dependencies" };
  return serviceStateLabel(service);
}

/**
 * A service not yet stopped or crashed: its process group still runs, or a stop still waits for its port to close (a
 * Stop then checks again). It has a Stop button, the rest a Start one.
 */
export function isServiceLive(service: Service | null): boolean {
  return service !== null && service.state !== "stopped" && service.state !== "crashed";
}
