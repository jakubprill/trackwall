import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitDirs, headRefName, readIfExists, statIfExists } from "./git-dir.ts";

/**
 * The HEAD commit read from the files of the git directory, without a `git` process (§4.5, ADR-79): `HEAD`, then the loose
 * file of the branch it names, then `packed-refs`. The card cache is keyed by this commit, so the graph and the tags of
 * repos whose cards are cached start no process at all. Whatever this reading does not cover for sure (the reftable
 * backend, a symbolic ref inside a ref, a HEAD outside `refs/heads/`) is `undefined`, and the caller asks git instead.
 */

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The commit hash; `null` for a branch without commits; `undefined` when git has to answer. */
export async function readHeadCommit(repo: string): Promise<string | null | undefined> {
  const dirs = await gitDirs(repo);
  if (!dirs) return undefined;
  const head = (await readFile(join(dirs.gitDir, "HEAD"), "utf8")).trim();
  if (OID.test(head)) return head;
  const ref = headRefName(head);
  // Other refs may live per worktree in the git directory (`refs/worktree/`, `refs/bisect/`), so git answers for them.
  if (!ref?.startsWith("refs/heads/")) return undefined;
  if (await statIfExists(join(dirs.commonDir, "reftable"))) return undefined;
  const loose = (await readIfExists(join(dirs.commonDir, ...ref.split("/")))).trim();
  if (loose !== "") return OID.test(loose) ? loose : undefined;
  return packedRef(await readIfExists(join(dirs.commonDir, "packed-refs")), ref) ?? null;
}

/** `<oid> <ref>` lines of `packed-refs`; `#` header and `^` peeled lines are skipped. */
export function packedRef(packed: string, ref: string): string | undefined {
  for (const line of packed.split("\n")) {
    const [oid, name] = line.trim().split(" ");
    if (name === ref && oid && OID.test(oid)) return oid;
  }
  return undefined;
}
