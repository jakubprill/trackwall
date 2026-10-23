import type { Commit, RepoStatusOk, TreeEntry } from "@trackwall/protocol";

/**
 * Parsery wyjścia gita w formatach maszynowych (`-z`, `--porcelain=v2`), bez zależności od języka gita.
 * Czyste funkcje, testowane bez procesu.
 */

/** Format `git log` zgodny z `parseLog`: pola rozdzielone 0x1f, commity rozdzielone NUL przez `-z`. */
export const LOG_FORMAT = "--format=%H%x1f%an%x1f%aI%x1f%s";

/** Wynik `git status --porcelain=v2 --branch -z` bez commita HEAD (dokłada go `vcs`). */
export interface ParsedStatus extends Omit<RepoStatusOk, "head"> {
  /** `false` w repo bez commitów (`branch.oid (initial)`). */
  hasCommits: boolean;
}

export function parseStatus(out: string): ParsedStatus {
  const status: ParsedStatus = { kind: "ok", branch: null, changes: 0, upstream: null, hasCommits: true };
  let upstreamName: string | undefined;
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.startsWith("# ")) {
      upstreamName = applyHeader(status, field.slice(2), upstreamName);
    } else if (/^[12u?] /.test(field)) {
      status.changes++;
      // Wpis zmiany nazwy (`2`) ma po sobie osobne pole ze starą ścieżką.
      if (field.startsWith("2 ")) i++;
    }
  }
  return status;
}

function applyHeader(status: ParsedStatus, header: string, upstreamName: string | undefined): string | undefined {
  const space = header.indexOf(" ");
  const key = header.slice(0, space);
  const value = header.slice(space + 1);
  if (key === "branch.oid") status.hasCommits = value !== "(initial)";
  else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
  else if (key === "branch.upstream") return value;
  else if (key === "branch.ab" && upstreamName !== undefined) {
    // Bez `branch.ab` gałąź śledzona nie istnieje (np. usunięta na zdalnym), więc nie ma czego porównać.
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
 * Wynik `git ls-tree -z --long <commit>:<katalog>`. Nazwy są względne do katalogu, więc `dir` dokleja się
 * z przodu, żeby UI mógł podać ścieżkę z powrotem bez składania jej samemu.
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
 * Wynik `git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'`: linia na każde zapytanie,
 * w tej samej kolejności. Brakujący obiekt git opisuje linią `<zapytanie> missing`, więc rozpoznajemy linie udane.
 */
export function parseObjects(out: string, count: number): (GitObject | undefined)[] {
  const lines = out.split("\n").slice(0, count);
  return lines.map((line) => {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
    return m ? { oid: m[1] ?? "", type: m[2] ?? "", size: Number(m[3]) } : undefined;
  });
}

/** Ta sama heurystyka co w gicie: NUL w pierwszych 8000 bajtach znaczy plik binarny. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}
