import type { ChangedFile, Commit, RepoStatusOk, TreeEntry } from "@trackwall/protocol";

/**
 * Parsers of git output in machine formats (`-z`, `--porcelain=v2`), independent of git's language.
 * Pure functions, tested without a process.
 */

/** The `git log` format `parseLog` expects: fields separated by 0x1f, commits separated by NUL through `-z`. */
export const LOG_FORMAT = "--format=%H%x1f%an%x1f%aI%x1f%s";

/** The result of `git status --porcelain=v2 --branch -z` without the HEAD commit (`vcs` adds it). */
export interface ParsedStatus extends Omit<RepoStatusOk, "head"> {
  /** The HEAD commit's hash (`branch.oid`); `null` in a repo without commits (`branch.oid (initial)`). */
  headOid: string | null;
}

export function parseStatus(out: string): ParsedStatus {
  const status: ParsedStatus = { kind: "ok", branch: null, changes: 0, untracked: 0, upstream: null, headOid: null };
  let upstreamName: string | undefined;
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.startsWith("# ")) {
      upstreamName = applyHeader(status, field.slice(2), upstreamName);
    } else if (/^[12u?] /.test(field)) {
      status.changes++;
      if (field.startsWith("? ")) status.untracked++;
      // A rename entry (`2`) is followed by a separate field with the old path.
      if (field.startsWith("2 ")) i++;
    }
  }
  return status;
}

function applyHeader(status: ParsedStatus, header: string, upstreamName: string | undefined): string | undefined {
  const space = header.indexOf(" ");
  const key = header.slice(0, space);
  const value = header.slice(space + 1);
  if (key === "branch.oid") status.headOid = value === "(initial)" ? null : value;
  else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
  else if (key === "branch.upstream") return value;
  else if (key === "branch.ab" && upstreamName !== undefined) {
    // Without `branch.ab` the tracked branch does not exist (e.g. deleted on the remote), so there is nothing to compare.
    const m = /^\+(\d+) -(\d+)$/.exec(value);
    if (m) status.upstream = { name: upstreamName, ahead: Number(m[1]), behind: Number(m[2]) };
  }
  return upstreamName;
}

export function parseLog(out: string): Commit[] {
  return out
    .split("\0")
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [hash = "", author = "", date = "", subject = ""] = record.replace(/^\n/, "").split("\x1f");
      return { hash, author, date, subject };
    });
}

/**
 * The result of `git ls-tree -z --long <commit>:<directory>`. Names are relative to the directory, so `dir` is prepended,
 * so that the UI can pass the path back without building it itself.
 */
export function parseTree(out: string, dir: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    const m = /^\d+ (blob|tree|commit) [0-9a-f]+ +(-|\d+)\t(.+)$/s.exec(record);
    if (!m) continue;
    const [, type, size, name = ""] = m;
    const path = dir === "" ? name : `${dir}/${name}`;
    if (type === "tree") entries.push({ name, path, kind: "dir" });
    else if (type === "commit") entries.push({ name, path, kind: "submodule" });
    else entries.push({ name, path, kind: "file", size: Number(size) });
  }
  return entries.sort(byKindThenName);
}

const KIND_ORDER: Record<TreeEntry["kind"], number> = { dir: 0, submodule: 1, file: 2 };

function byKindThenName(a: TreeEntry, b: TreeEntry): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name);
}

export interface GitObject {
  oid: string;
  type: string;
  size: number;
}

/**
 * The result of `git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'`: a line per query,
 * in the same order. Git describes a missing object with the line `<query> missing`, so we recognise the successful lines.
 */
export function parseObjects(out: string, count: number): (GitObject | undefined)[] {
  const lines = out.split("\n").slice(0, count);
  return lines.map((line) => {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
    return m ? { oid: m[1] ?? "", type: m[2] ?? "", size: Number(m[3]) } : undefined;
  });
}

/**
 * The result of `git cat-file --batch`: for each query a header `<oid> <type> <size>`, the contents and a newline, or
 * the line `<query> missing`. Returns blob contents in query order; a missing object, an object of another type
 * and contents cut by the end of output as `undefined`.
 */
export function parseBlobs(out: Buffer, count: number): (Buffer | undefined)[] {
  const blobs: (Buffer | undefined)[] = [];
  let pos = 0;
  while (blobs.length < count) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) break;
    const header = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(out.subarray(pos, eol).toString("utf8"));
    pos = eol + 1;
    if (!header) {
      blobs.push(undefined);
      continue;
    }
    const size = Number(header[2]);
    const end = pos + size;
    blobs.push(header[1] === "blob" && end <= out.length ? out.subarray(pos, end) : undefined);
    pos = end + 1;
  }
  while (blobs.length < count) blobs.push(undefined);
  return blobs;
}

/** The same heuristic as git's: a NUL in the first 8000 bytes means a binary file. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/**
 * `diff --name-status -z` (`M\0path\0`) and `diff --numstat -z` (`added\tdeleted\tpath\0`, `-` for a binary
 * file) without rename detection, so every file has one entry in both.
 */
export function parseChangedFiles(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = parseNumstat(numstat);
  const fields = nameStatus.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    const change = status === "A" ? "added" : status === "D" ? "deleted" : "modified";
    files.push({ path, change, ...(counts.get(path) ?? { additions: null, deletions: null }) });
  }
  return files;
}

function parseNumstat(numstat: string): Map<string, Pick<ChangedFile, "additions" | "deletions">> {
  const lineCount = (n: string) => (n === "-" ? null : Number(n));
  const counts = new Map<string, Pick<ChangedFile, "additions" | "deletions">>();
  for (const record of numstat.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (m) counts.set(m[3] ?? "", { additions: lineCount(m[1] ?? "-"), deletions: lineCount(m[2] ?? "-") });
  }
  return counts;
}

/**
 * Entries of `-z` output as bytes, without decoding: a file name outside UTF-8 (on Linux) would after decoding point to
 * a file that does not exist. A piece without a trailing NUL (cut output) is an incomplete path, so it is dropped.
 */
export function parseNulTerminated(out: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  let start = 0;
  for (let end = out.indexOf(0); end !== -1; end = out.indexOf(0, start)) {
    entries.push(out.subarray(start, end));
    start = end + 1;
  }
  return entries;
}
