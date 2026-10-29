import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TRACKWALL_DIR, type TrackwallFolder } from "@trackwall/protocol";
import { DomainError } from "./errors.ts";

/** A folder of Trackwall's folder in the projects folder (ADR-125). */
export function trackwallDir(projectsDir: string, folder: TrackwallFolder): string {
  return join(projectsDir, TRACKWALL_DIR, folder);
}

/**
 * `.trackwall` and, with `folder`, that folder of it, made where missing and refused where not a real folder, before
 * Trackwall writes there; returns the deepest. A link, which an agent with file tools in the projects folder can make,
 * would send what Trackwall puts there (the local config, worktrees, removed repos) somewhere else. Each is made without
 * `recursive`, so a projects folder that is gone (a drive unplugged, a folder renamed) is not made again.
 */
export async function ensureTrackwallDir(projectsDir: string, folder?: TrackwallFolder): Promise<string> {
  const base = join(projectsDir, TRACKWALL_DIR);
  await ensureRealFolder(base);
  if (folder === undefined) return base;
  const dir = trackwallDir(projectsDir, folder);
  await ensureRealFolder(dir);
  return dir;
}

async function ensureRealFolder(dir: string): Promise<void> {
  await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  if (!(await lstat(dir)).isDirectory())
    throw new DomainError("bad_request", `${dir} is not a folder (a link?); Trackwall writes only into a real one`);
}
