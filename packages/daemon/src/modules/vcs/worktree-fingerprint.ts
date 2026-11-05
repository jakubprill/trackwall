import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { mapLimit } from "../../infra/map-limit.ts";
import { changedPaths } from "./worktree-changes.ts";

/**
 * A task worktree's fingerprint (ADR-207): one hash of what its files hold, so a verification can tell that they changed
 * after its run started. It is the files that differ from the task's base commit, counted as the task's Changes count them
 * (new files with, ignored ones without), each with a hash of its content on disk; every other file is the base commit's.
 * So only content counts: a commit (the agent's own, a round commit after its turn, ADR-168) or a file written again with
 * the same content leaves it as it was. Nothing is written to the repo, as with the Changes.
 */

/** Files hashed at once: each one is a read of the disk, which an antivirus scans on Windows. */
const HASH_CONCURRENCY = 8;

/** A larger file (a jar, a database dump) counts by its size and modification time instead of its content. */
const CONTENT_HASH_MAX_BYTES = 16 * 1024 * 1024;

export async function worktreeFingerprint(dir: string, base: string, scratchDir: string): Promise<string> {
  const listed = await changedPaths(dir, base, scratchDir);
  const paths = listed.paths.sort();
  const digests = await mapLimit(paths, HASH_CONCURRENCY, (path) => fileDigest(resolve(dir, path)));
  const hash = createHash("sha256").update(`base ${base}\n`);
  paths.forEach((path, i) => {
    hash.update(`${path}\0${digests[i]}\n`);
  });
  // A cut file list (tens of thousands of new files) still gives one value; an edit past the cut is not seen.
  if (listed.truncated) hash.update("truncated\n");
  return hash.digest("hex");
}

/** What one changed path holds now, without following a link: a deleted file, a link's target, a nested repo or a content hash. */
async function fileDigest(path: string): Promise<string> {
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (info === undefined) return "missing";
  if (info.isSymbolicLink()) return `link ${await readlink(path)}`;
  // A directory is a nested repo (`git add` would record its HEAD); what changes inside it is not this worktree's change.
  if (info.isDirectory()) return "directory";
  // The executable bit counts too: git records it, and a script that loses it fails a test.
  const mode = (info.mode & 0o111) !== 0 ? "x" : "-";
  if (info.size > CONTENT_HASH_MAX_BYTES) return `${mode} size ${info.size} mtime ${info.mtimeMs}`;
  return `${mode} ${await contentHash(path)}`;
}

function contentHash(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}
