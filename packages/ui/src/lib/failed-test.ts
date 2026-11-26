import type { TestFailure } from "@trackwall/protocol";

/**
 * A failed test of a verification opened in the task panel (ADR-302): the values an assertion compared, and its stack
 * trace line by line, with the frames of the repo's own code told apart from those of libraries, so the user sees where
 * in their code it failed. No React here, so the reading is tested on its own.
 */

/** The values an assertion compared, as its message gives them. */
export interface ExpectedActual {
  expected: string;
  actual: string;
}

/** Longer values (a whole JSON body) stay in the message: side by side on two lines they would not compare at a glance. */
const VALUE_MAX_CHARS = 200;

/**
 * `expected: <3> but was: <4>` (JUnit 5, with an optional `message ==> ` before it), `expected:<3> but was:<4>` (JUnit 4,
 * Spring's MockMvc `Status expected:<200> but was:<500>`). Greedy inside the brackets: a value may hold `>` itself.
 */
const BRACKETED = /expected:\s*<([\s\S]*)>\s+but was:\s*<([\s\S]*)>\s*$/;
/** AssertJ: `expected: 3` and ` but was: 4` on lines of their own. */
const ASSERTJ = /^\s*expected:\s*(.+)\n\s*but was:\s*(.+)\s*$/m;

/** The expected and actual values of an assertion's message; `null` when it names none or they are too long to compare. */
export function expectedActual(message: string | null): ExpectedActual | null {
  if (message === null) return null;
  const match = BRACKETED.exec(message) ?? ASSERTJ.exec(message);
  const [, expected, actual] = match ?? [];
  if (expected === undefined || actual === undefined) return null;
  if (expected.length > VALUE_MAX_CHARS || actual.length > VALUE_MAX_CHARS) return null;
  return { expected, actual };
}

/**
 * One line of a failed test's stack trace: `exception` the line that names an exception (the first one, `Caused by:`),
 * `own` a frame in the test's own code, which opens in the editor, `library` any other frame, `other` the rest (`... 12
 * more`, a message's further lines).
 */
export interface TraceLine {
  kind: "exception" | "own" | "library" | "other";
  text: string;
}

const FRAME = /^\s*at\s+(?:[^\s()/]*\/){0,2}([^\s()/]+)\.[^\s().]+\(/;
const CAUSE = /^\s*(?:Caused by|Suppressed):\s/;

/**
 * The trace's lines as the report kept them. A frame is the test's own code when its class shares the test class's
 * first two package names (`com.example` of `com.example.shop.CartTest`, or `shop` of `shop.CartTest`): libraries live
 * under other names, and a frame of the repo outside the test's package still opens, since the daemon looks it up.
 */
export function traceLines(failure: TestFailure): TraceLine[] {
  const own = ownPrefix(failure.className ?? failure.suite);
  return failure.lines.map((text, i) => ({ kind: lineKind(text, i, own), text }));
}

function lineKind(text: string, index: number, own: string | null): TraceLine["kind"] {
  const frame = FRAME.exec(text);
  if (frame) return own !== null && frame[1]?.startsWith(own) ? "own" : "library";
  if (index === 0 || CAUSE.test(text)) return "exception";
  return "other";
}

/** `com.example.` of `com.example.shop.CartTest`, `shop.` of `shop.CartTest`; `null` for a class without a package. */
function ownPrefix(className: string): string | null {
  const packages = className.split(".").slice(0, -1);
  if (packages.length === 0 || packages.some((name) => name === "")) return null;
  return `${packages.slice(0, 2).join(".")}.`;
}

/** A row of the trace as the panel shows it: a line, or library frames folded into one row after the first of their run. */
export type TraceRow = TraceLine | { kind: "folded"; count: number };

/**
 * The trace with each run of library frames folded after its first frame, so the frames of the test's own code stand
 * out (a JUnit or Spring trace is mostly the framework); a run of two keeps both, as a fold would hide no more than it shows.
 */
export function foldedTrace(lines: readonly TraceLine[]): TraceRow[] {
  const rows: TraceRow[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line === undefined) break;
    const run = line.kind === "library" ? libraryRun(lines, i) : 1;
    rows.push(line);
    if (run > 2) rows.push({ kind: "folded", count: run - 1 });
    else if (run === 2) rows.push(lines[i + 1] ?? line);
    i += run;
  }
  return rows;
}

/** How many library frames follow each other from `start` on. */
function libraryRun(lines: readonly TraceLine[], start: number): number {
  let end = start;
  while (lines[end]?.kind === "library") end++;
  return end - start;
}

/** The address of a file at a line for VS Code: `vscode://…/Cart.java:42`; the file's top without a line. */
export function atLine(link: string, line: number | null): string {
  return line === null ? link : `${link}:${line}`;
}
