import { basename } from "node:path";
import { LOCAL_CONFIG_FILES, type LocalConfigFileName } from "@trackwall/protocol";

/**
 * Where things lie in the workspace store (§4.13, ADR-298): the repos' local config files under `repos/<repo folder>/`, so
 * the store's other folders can never be mistaken for a repo named like them. A store from before ADR-298 kept them at
 * `<repo folder>/<file>`; `moveToReposFolder` names the moves that bring such a store, or a file an older Trackwall on
 * another computer committed into it, into this layout.
 */

/** The store's folder of the repos' local config files. */
const REPOS_FOLDER = "repos";

/** A repo's file in the store, with `/`: under the name of the repo's folder, which stays when its identifier gets a suffix. */
export function storePath(dir: string, file: LocalConfigFileName): string {
  return `${REPOS_FOLDER}/${basename(dir)}/${file}`;
}

/** A path of the store and where the current layout puts it. */
export interface StoreMove {
  from: string;
  to: string;
}

/**
 * The files of the store at `paths` (a commit's files, with `/`) that lie where a store from before ADR-298 put them: a
 * local config file right under a repo's folder. Nothing else at two levels is a repo's file, so the store's other
 * folders stay where they are.
 */
export function moveToReposFolder(paths: readonly string[]): StoreMove[] {
  const names: readonly string[] = LOCAL_CONFIG_FILES;
  return paths.flatMap((from) => {
    const parts = from.split("/");
    const [folder, file] = parts;
    if (parts.length !== 2 || folder === undefined || file === undefined || !names.includes(file)) return [];
    return [{ from, to: `${REPOS_FOLDER}/${from}` }];
  });
}
