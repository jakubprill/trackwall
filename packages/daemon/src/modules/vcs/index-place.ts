import { join, resolve } from "node:path";
import { git } from "./git.ts";
import { optionalKey, statIfExists } from "./git-dir.ts";

/**
 * Where a working directory's index lies and which empty blob hash its repo has: what every read of its changes
 * (`worktree-changes.ts`) needs before its first diff. Asking git costs a process, which the "Changes" tab would start
 * every two seconds and every task's warnings every five; where each process start is inspected (a managed Windows
 * machine, #183) that is a second per read and a quarter of its time. Neither answer changes while the directory stays
 * the same checkout, so it is remembered by the `.git` entry of the directory: a file in a task worktree, which changes
 * only when the worktree is made again, and a folder in a clone, which changes with nearly every git command, so a clone
 * is asked again nearly every time, as before.
 */

/** The empty blob hash in both git object formats (`git hash-object -t blob /dev/null`). */
const EMPTY_BLOB = new Map([
  ["sha1", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
  ["sha256", "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"],
]);

/** Beyond this many directories the memory starts again, so worktrees removed long ago do not stay for the daemon's life. */
const MAX_PLACES = 500;

export interface IndexPlace {
  /** The full path of the index file. */
  index: string;
  emptyBlob: string;
}

export class IndexPlaces {
  readonly #known = new Map<string, { key: string; place: IndexPlace }>();

  async of(dir: string): Promise<IndexPlace> {
    // Taken before git answers: a worktree made again meanwhile has another key next time.
    const key = optionalKey(await statIfExists(join(dir, ".git")).catch(() => undefined));
    const known = this.#known.get(dir);
    if (known?.key === key) return known.place;
    const place = await askGit(dir);
    // Without a `.git` entry of its own (a folder inside a repo) there is nothing to tell a change by.
    if (key !== optionalKey(undefined)) {
      if (!known && this.#known.size >= MAX_PLACES) this.#known.clear();
      this.#known.set(dir, { key, place });
    }
    return place;
  }
}

async function askGit(dir: string): Promise<IndexPlace> {
  const out = (await git(dir, ["rev-parse", "--git-path", "index", "--show-object-format"])).stdout.toString("utf8").trim();
  const [indexPath, objectFormat] = out.split(/\r?\n/);
  const emptyBlob = objectFormat === undefined ? undefined : EMPTY_BLOB.get(objectFormat);
  if (!indexPath || emptyBlob === undefined) throw new Error(`git rev-parse did not give the index path and a known object format: ${out}`);
  return { index: resolve(dir, indexPath), emptyBlob };
}
