/**
 * Puts Trackwall's draft into the repo's own merge request template (ADR-238): the summary under the template's first
 * heading that asks what the change is, the check steps and evidence under its first heading that asks how it was
 * tested, each right below its heading, so the template's own guidance and checklist stay. A part that finds no such
 * heading goes where a reader looks for it without one: the summary above the template, the evidence below it.
 */

/** One of `words` as a whole word of any language's letters, in any case. */
function wordsPattern(words: string): RegExp {
  return new RegExp(`(^|[^\\p{L}])(${words})([^\\p{L}]|$)`, "iu");
}

/** A heading that asks how the change was checked, in English or Polish; tried first, so "What to test" is one. */
const TESTING_HEADING = wordsPattern("test\\p{L}*|verif\\p{L}*|qa|checks?|evidence|proof|sprawd\\p{L}*|weryfik\\p{L}*");
/** A heading that asks what the change is or why. */
const SUMMARY_HEADING = wordsPattern(
  "what|why|summary|description|overview|changes?|context|purpose|motivation|opis|zmian\\p{L}*|co|dlaczego|cel",
);

const HEADING = /^ {0,3}#{1,6}\s+(.*)$/;

/** Markdown headings outside fenced code, by line number, with their text. */
function headings(lines: readonly string[]): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const text = fenced ? undefined : HEADING.exec(line)?.[1];
    if (text !== undefined) found.push({ line: index, text });
  });
  return found;
}

/** The template with `summary` and `evidence` (either may be empty) placed in it. */
export function fillTemplate(template: string, summary: string, evidence: string): string {
  const lines = template.replace(/\s+$/, "").split("\n");
  const found = headings(lines);
  const testing = found.find((h) => TESTING_HEADING.test(h.text));
  const about = found.find((h) => !TESTING_HEADING.test(h.text) && SUMMARY_HEADING.test(h.text));
  const inserts = new Map<number, string>();
  if (summary !== "" && about) inserts.set(about.line, summary);
  if (evidence !== "" && testing) inserts.set(testing.line, evidence);
  const filled = lines.flatMap((line, index) => {
    const text = inserts.get(index);
    if (text === undefined) return [line];
    // One blank line between the text and what follows, whether the template had one there or not.
    const next = lines[index + 1];
    return next === undefined || next.trim() === "" ? [line, "", text] : [line, "", text, ""];
  });
  const before = summary !== "" && !about ? [summary, ""] : [];
  const after = evidence !== "" && !testing ? ["", evidence] : [];
  return [...before, ...filled, ...after].join("\n");
}
