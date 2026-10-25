import type { ReviewSide } from "@trackwall/protocol";

/**
 * Lines of a task's unified diff (ADR-31) with a kind, on which the colour in the "Changes" view depends. A file header
 * runs from `diff --git` to the first `@@`: only there are `+++` and `---` file names, while in the body of a change it is
 * an added or removed line that starts with `++` or `--` (for example `-- SQL comment`). A line of a change also gets
 * its place in a file, which a review comment points to (ADR-62).
 */
export type DiffLineKind = "file" | "meta" | "hunk" | "added" | "removed" | "context";

/**
 * Where a line of a change is: the file relative to the repo root and the line number, in the worktree's file (`new`:
 * added and unchanged lines) or in the base commit's (`old`: removed lines).
 */
export interface DiffAnchor {
  path: string;
  side: ReviewSide;
  line: number;
}

/** A diff line with its place in the text (a stable key on refresh), kind and, for a line of a change, its place in a file. */
export interface DiffLine {
  offset: number;
  text: string;
  kind: DiffLineKind;
  anchor: DiffAnchor | null;
}

function bodyLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

const HUNK_START = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * A file name from `--- a/<path>` or `+++ b/<path>` without its `a/` or `b/`; `null` for `/dev/null`. Git ends a name
 * with a space in a tab, and puts a name with special characters in quotes with C escapes, non-ASCII bytes as octal.
 */
function headerPath(header: string): string | null {
  const name = header.endsWith("\t") ? header.slice(0, -1) : header;
  if (name === "/dev/null") return null;
  const unquoted = name.startsWith('"') && name.endsWith('"') ? unquote(name.slice(1, -1)) : name;
  return unquoted.replace(/^[ab]\//, "");
}

function unquote(text: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const next = text.charAt(i + 1);
    bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Line numbers inside one file of the diff: the file from its header, and the next old and new line from the last hunk. */
class FilePosition {
  #oldPath: string | null = null;
  #newPath: string | null = null;
  #oldLine = 0;
  #newLine = 0;

  /** Follows the file header and hunk headers; for a line of a change returns its anchor and moves past it. */
  read(kind: DiffLineKind, text: string): DiffAnchor | null {
    if (kind === "file" || kind === "meta") this.#header(text);
    else if (kind === "hunk") this.#hunk(text);
    else return this.#next(kind, text);
    return null;
  }

  #header(text: string): void {
    if (text.startsWith("diff --git ")) this.#oldPath = this.#newPath = null;
    else if (text.startsWith("--- ")) this.#oldPath = headerPath(text.slice(4));
    else if (text.startsWith("+++ ")) this.#newPath = headerPath(text.slice(4));
  }

  #hunk(text: string): void {
    const match = HUNK_START.exec(text);
    this.#oldLine = Number(match?.[1] ?? 0);
    this.#newLine = Number(match?.[2] ?? 0);
  }

  /** `null` for `\ No newline at end of file` and for a file without a name in its header. */
  #next(kind: "added" | "removed" | "context", text: string): DiffAnchor | null {
    if (text.startsWith("\\")) return null;
    const path = this.#newPath ?? this.#oldPath;
    if (path === null) return null;
    if (kind === "removed") return { path, side: "old", line: this.#oldLine++ };
    if (kind === "context") this.#oldLine++;
    return { path, side: "new", line: this.#newLine++ };
  }
}

/** The first `maxLines` lines of the diff; `more` when there are further ones. */
export function diffLines(patch: string, maxLines: number): { lines: DiffLine[]; more: boolean } {
  const lines: DiffLine[] = [];
  const position = new FilePosition();
  let offset = 0;
  let inHeader = false;
  while (offset < patch.length && lines.length < maxLines) {
    const end = patch.indexOf("\n", offset);
    const text = patch.slice(offset, end < 0 ? patch.length : end);
    const file = text.startsWith("diff --git ");
    if (file) inHeader = true;
    else if (text.startsWith("@@")) inHeader = false;
    const kind = file ? "file" : inHeader ? "meta" : bodyLineKind(text);
    lines.push({ offset, text, kind, anchor: position.read(kind, text) });
    offset = end < 0 ? patch.length : end + 1;
  }
  return { lines, more: offset < patch.length };
}
