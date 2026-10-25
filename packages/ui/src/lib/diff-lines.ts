/**
 * Lines of a task's unified diff (ADR-31) with a kind, on which the colour in the "Changes" view depends. A file header
 * runs from `diff --git` to the first `@@`: only there are `+++` and `---` file names, while in the body of a change it is
 * an added or removed line that starts with `++` or `--` (for example `-- SQL comment`).
 */
export type DiffLineKind = "file" | "meta" | "hunk" | "added" | "removed" | "context";

function bodyLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/** A diff line with its place in the text (a stable key on refresh) and kind. */
export interface DiffLine {
  offset: number;
  text: string;
  kind: DiffLineKind;
}

/** The first `maxLines` lines of the diff; `more` when there are further ones. */
export function diffLines(patch: string, maxLines: number): { lines: DiffLine[]; more: boolean } {
  const lines: DiffLine[] = [];
  let offset = 0;
  let inHeader = false;
  while (offset < patch.length && lines.length < maxLines) {
    const end = patch.indexOf("\n", offset);
    const text = patch.slice(offset, end < 0 ? patch.length : end);
    const file = text.startsWith("diff --git ");
    if (file) inHeader = true;
    else if (text.startsWith("@@")) inHeader = false;
    lines.push({ offset, text, kind: file ? "file" : inHeader ? "meta" : bodyLineKind(text) });
    offset = end < 0 ? patch.length : end + 1;
  }
  return { lines, more: offset < patch.length };
}
