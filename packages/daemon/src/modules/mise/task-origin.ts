import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { MiseTask } from "@trackwall/protocol";
import { isInside } from "../../infra/path-inside.ts";

/**
 * Where the mise tasks of a repo root are defined (§4.7, ADR-110), from the file `mise tasks ls` names as each one's
 * `source`: outside the repo, or in the repo and tracked by git or not. Paths are compared after resolving links on both
 * sides, as mise may report the canonical path (`/private/var` on macOS) of a repo opened through a link.
 */

/** What finding the origin needs from `vcs`: which of the repo's paths its index tracks. */
export interface TrackedPaths {
  trackedPaths(dir: string, paths: readonly string[]): Promise<Set<string>>;
}

type Origin = Pick<MiseTask, "source" | "origin">;

const UNKNOWN: Origin = { source: null, origin: null };

/**
 * The origin of a mise task by its source as mise gave it, for every source of `sources`. A source in the repo is given
 * relative to the repo root with `/`. A source that cannot be resolved, or one in the repo when git cannot say what it
 * tracks (no git directory, a git error), has no origin rather than a wrong one.
 */
export async function taskOrigins(
  dir: string,
  sources: readonly (string | null)[],
  vcs: TrackedPaths,
): Promise<(source: string | null) => Origin> {
  const root = await realpath(dir).catch(() => dir);
  const known = [...new Set(sources)].flatMap((source) => (source === null ? [] : [source]));
  const resolved = await Promise.all(known.map(async (source) => ({ source, path: await realpath(source).catch(() => null) })));
  const origins = new Map<string, Origin>();
  const inRepo = new Map<string, string>();
  for (const { source, path } of resolved) {
    if (path === null) origins.set(source, { source, origin: null });
    else if (isInside(root, path)) inRepo.set(source, relative(root, path).split(sep).join("/"));
    else origins.set(source, { source, origin: "outside" });
  }
  const tracked = await vcs.trackedPaths(dir, [...inRepo.values()]).catch(() => null);
  for (const [source, path] of inRepo)
    origins.set(source, { source: path, origin: tracked === null ? null : tracked.has(path) ? "repo" : "local" });
  return (source) => (source === null ? UNKNOWN : (origins.get(source) ?? UNKNOWN));
}
