/**
 * Linie zunifikowanego diffu zadania (ADR-31) z rodzajem, od którego zależy kolor w widoku „Zmiany”. Nagłówki pliku
 * (`+++`, `---`) to nie dodane ani usunięte linie, choć zaczynają się tym samym znakiem.
 */
export type DiffLineKind = "file" | "meta" | "hunk" | "added" | "removed" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("diff --git ")) return "file";
  if (line.startsWith("+++ ") || line.startsWith("--- ") || /^(index|new file|deleted file|old mode|new mode|Binary files) /.test(line))
    return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/** Linia diffu z miejscem w tekście (stały klucz przy odświeżeniu) i rodzajem. */
export interface DiffLine {
  offset: number;
  text: string;
  kind: DiffLineKind;
}

/** Pierwsze `maxLines` linii diffu; `more`, gdy zostały kolejne. */
export function diffLines(patch: string, maxLines: number): { lines: DiffLine[]; more: boolean } {
  const lines: DiffLine[] = [];
  let offset = 0;
  while (offset < patch.length && lines.length < maxLines) {
    const end = patch.indexOf("\n", offset);
    const text = patch.slice(offset, end < 0 ? patch.length : end);
    lines.push({ offset, text, kind: diffLineKind(text) });
    offset = end < 0 ? patch.length : end + 1;
  }
  return { lines, more: offset < patch.length };
}
