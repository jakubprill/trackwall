import type { RepoSnapshot } from "../../src/modules/cards/snapshot.ts";

const COMMIT = "a".repeat(40);

/** A commit for extractors without git: files with content and, separately, files known only from the list (e.g. a Dockerfile). */
export function snapshotOf(files: Record<string, string>, otherPaths: string[] = []): RepoSnapshot {
  return {
    commit: COMMIT,
    paths: [...Object.keys(files), ...otherPaths],
    pathsComplete: true,
    text: (path) => files[path],
    typeFiles: new Set(),
    problems: [],
  };
}
