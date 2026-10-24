import type { RepoSnapshot } from "../../src/modules/cards/snapshot.ts";

const COMMIT = "a".repeat(40);

/** Commit dla ekstraktorów bez gita: pliki z treścią i, osobno, pliki znane tylko z listy (np. Dockerfile). */
export function snapshotOf(files: Record<string, string>, otherPaths: string[] = []): RepoSnapshot {
  return { commit: COMMIT, paths: [...Object.keys(files), ...otherPaths], text: (path) => files[path], typeFiles: new Set(), problems: [] };
}
