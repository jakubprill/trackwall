import { PUT_ASIDE_MESSAGE, type PutAside, type PutAsideFile } from "@trackwall/protocol";
import { git } from "./git.ts";

/**
 * Changes put aside so that a pull can go on (§4.5, ADR-271): the tracked changes of the working directory, staged or not,
 * go into a git stash with Trackwall's message, never deleted; untracked files stay, since a fast-forward never touches
 * them. The stash is git's own, so `git stash pop` in a terminal brings it back too. An entry is named by its commit,
 * because the `stash@{n}` numbers shift with every newer stash.
 */

/** Trackwall makes the stash commit, not the user, and a machine without `user.name` must not stop it. */
const IDENTITY = ["-c", "user.name=Trackwall", "-c", "user.email=trackwall@localhost"];

/** git's status letter as a change; a type change (`T`) is a modification to the user. */
function changeOf(status: string): PutAsideFile["change"] | undefined {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return status === "M" || status === "T" ? "modified" : undefined;
}

/** The changed tracked files against HEAD, staged or not: what `stash push` would take. */
export async function changedTrackedFiles(dir: string): Promise<PutAsideFile[]> {
  const { stdout } = await git(dir, ["diff", "--no-renames", "--name-status", "-z", "HEAD", "--"]);
  const fields = stdout.toString("utf8").split("\0");
  const files: PutAsideFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const change = changeOf(fields[i] ?? "");
    const path = fields[i + 1];
    if (path !== undefined && change !== undefined) files.push({ path, change });
  }
  return files;
}

/** Moves the tracked changes into a new stash and returns its commit. */
export async function putAside(dir: string): Promise<string> {
  await git(dir, [...IDENTITY, "stash", "push", "--quiet", "--message", PUT_ASIDE_MESSAGE]);
  return (await git(dir, ["rev-parse", "--verify", "--quiet", "refs/stash"])).stdout.toString("utf8").trim();
}

/** Brings a put-aside back, with what was staged staged again; git refuses and keeps it when the files changed meanwhile. */
export async function bringBack(dir: string, id: string): Promise<void> {
  await git(dir, ["stash", "pop", "--index", "--quiet", await stashRef(dir, id)]);
}

export async function dropPutAside(dir: string, id: string): Promise<void> {
  await git(dir, ["stash", "drop", "--quiet", await stashRef(dir, id)]);
}

/** Trackwall's put-asides in the stash list, newest first; the user's own stashes are left out. */
export async function listPutAsides(dir: string): Promise<PutAside[]> {
  const entries = (await stashEntries(dir)).filter((e) => e.subject.endsWith(`: ${PUT_ASIDE_MESSAGE}`));
  return Promise.all(entries.map(async (e) => ({ id: e.id, branch: branchOf(e.subject), at: e.at, files: await stashFiles(dir, e.id) })));
}

/** One put-aside, for the result of the pull that made it. */
export async function describePutAside(dir: string, id: string): Promise<PutAside> {
  const found = (await listPutAsides(dir)).find((p) => p.id === id);
  if (!found) throw new Error(`the put-aside ${id} is not in the stash list`);
  return found;
}

interface StashEntry {
  id: string;
  subject: string;
  at: string;
}

async function stashEntries(dir: string): Promise<StashEntry[]> {
  const { stdout } = await git(dir, ["stash", "list", "--format=%H%x1f%gs%x1f%cI"]);
  return stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [id = "", subject = "", at = ""] = line.split("\x1f");
      return { id, subject, at };
    });
}

/** `stash@{n}` of a stash commit at this moment. */
async function stashRef(dir: string, id: string): Promise<string> {
  const index = (await stashEntries(dir)).findIndex((e) => e.id === id);
  if (index < 0) throw new Error("these changes are no longer in the stash list");
  return `stash@{${index}}`;
}

/** "On develop: …" or "On (no branch): …", as git writes the message of `stash push`. */
function branchOf(subject: string): string | null {
  const branch = /^On (.+?): /.exec(subject)?.[1];
  return branch === undefined || branch === "(no branch)" ? null : branch;
}

async function stashFiles(dir: string, id: string): Promise<string[]> {
  const { stdout } = await git(dir, ["stash", "show", "--name-only", "--no-renames", "-z", id]);
  return stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
}
