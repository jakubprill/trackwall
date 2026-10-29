import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TRACKWALL_DIR, type TrackwallFolder } from "@trackwall/protocol";
import { DomainError } from "./errors.ts";

/** A folder of Trackwall's folder in the projects folder (ADR-125). */
export function trackwallDir(projectsDir: string, folder: TrackwallFolder): string {
  return join(projectsDir, TRACKWALL_DIR, folder);
}

/**
 * Makes `.trackwall` when it is missing and refuses it when it is not a real folder, before Trackwall writes in it: a
 * link there, which an agent with file tools in the projects folder can make, would send every folder of it, and the
 * local config, worktrees and removed repos Trackwall puts there, somewhere else.
 */
export async function ensureTrackwallDir(projectsDir: string): Promise<void> {
  const dir = join(projectsDir, TRACKWALL_DIR);
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory())
    throw new DomainError("bad_request", `${dir} is not a folder (a link?); Trackwall writes only into a real one`);
}
