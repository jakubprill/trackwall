import type { CallFiles } from "../../src/modules/cards/call-files.ts";
import type { CallSelection } from "../../src/modules/cards/read-snapshot.ts";
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
    callSources: null,
    problems: [],
  };
}

/** No call files: the card's endpoints get no reach (`reaches: null`), for tests of other facts (ADR-82). */
export const NO_REACH: CallFiles = { files: null, problems: [], complete: true };

/** A commit read without source files for the endpoint reach, for tests of other facts. */
export const NO_CALL_SOURCES: CallSelection = { accepts: () => false, kept: () => undefined };
