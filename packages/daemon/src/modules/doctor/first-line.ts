/** A program's error in a doctor's summary: its first line, cut to this length. */
const MAX_MESSAGE_CHARS = 200;

/** The first of `lines` that `keep` accepts (the first line without one), cut to `MAX_MESSAGE_CHARS`. */
export function firstLine(text: string, keep: (line: string) => boolean = () => true): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim());
  const line = lines.find((l) => l !== "" && keep(l)) ?? lines[0] ?? "";
  return line.length > MAX_MESSAGE_CHARS ? `${line.slice(0, MAX_MESSAGE_CHARS - 1)}…` : line;
}
