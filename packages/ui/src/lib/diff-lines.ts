/**
 * Linie zunifikowanego diffu zadania (ADR-31) z rodzajem, od którego zależy kolor w widoku „Zmiany”. Nagłówek pliku
 * trwa od `diff --git` do pierwszego `@@`: tylko tam `+++` i `---` to nazwy plików, a w treści zmiany to dodana albo
 * usunięta linia, która zaczyna się od `++` albo `--` (np. `-- komentarz SQL`).
 */
export type DiffLineKind = "file" | "meta" | "hunk" | "added" | "removed" | "context";

function bodyLineKind(line: string): DiffLineKind {
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
