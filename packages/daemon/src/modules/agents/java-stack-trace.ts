/**
 * A Java stack trace as the JVM prints it (`Throwable.printStackTrace`) and loggers copy it, read for a task from a stack
 * trace (ADR-222, §4.4): its exceptions in order, the thrown one, each `Caused by:` and `Suppressed:`, each with its
 * frames. Reading it only names classes, methods, file names and lines; nothing in it is ever a path the daemon opens or
 * an argument of a command (`stack-trace-frames.ts` finds the files among the repo's tracked ones instead).
 */

/** One `at …` line. */
export interface JavaFrame {
  /** The class as the frame names it, with `$` for nested, anonymous and lambda classes: `com.example.Order$Line`. */
  className: string;
  /** `total`, `lambda$total$0`, `<init>`. */
  method: string;
  /** The source file's name, `Order.java`; `null` for `Native Method`, `Unknown Source` and anything that is not a bare file name. */
  file: string | null;
  /** `null` when the frame gives none. */
  line: number | null;
}

/** `thrown` the exception the trace starts with; `caused_by` and `suppressed` the ones under it; `wrapped_by` logback's `%rEx`. */
type JavaExceptionKind = "thrown" | "caused_by" | "suppressed" | "wrapped_by";

export interface JavaException {
  kind: JavaExceptionKind;
  /** The exception's class, `java.lang.IllegalStateException`; `null` for frames pasted without the line that names it. */
  type: string | null;
  /**
   * How deep it sits under `Suppressed:` exceptions, from the indentation the JVM gives them: 0 on the main chain, so the
   * main chain's last `Caused by:` is the root cause and a suppressed exception's own cause is not.
   */
  depth: number;
  frames: JavaFrame[];
  /** The frames the JVM left out as the same as the enclosing exception's (`... 12 more`, `... 12 common frames omitted`). */
  omitted: number;
}

/**
 * `at com.example.Order.total(Order.java:42)`, also after a module or class loader (`java.base/`, `java.base@17/`,
 * `app//`) and with a logger's suffix after it (`~[shop.jar:?]`). The parentheses hold the place.
 */
const FRAME = /(?:^|\s)at\s+(?:[^\s()/]*\/){0,2}([^\s()/]+)\.([^\s().]+)\(([^()]*)\)/u;
/** A place that names a file: `Order.java:42`, or `Order.java` without a line. */
const PLACE = /^([^\s/\\:]+\.[A-Za-z]+)(?::(\d+))?$/;
/** `java.lang.IllegalStateException: message`, after `Caused by: `, `Suppressed: `, `Wrapped by: ` or `Exception in thread "main" `. */
const HEADER =
  /^(\s*)(?:Exception in thread "[^"]*"\s+)?(?:(Caused by|Suppressed|Wrapped by):\s+)?((?:[\p{L}_$][\p{L}\p{N}_$]*\.)+[\p{L}_$][\p{L}\p{N}_$]*)(?::|\s*$)/u;
/** A class name that says it is a throwable: a header without one opens an exception only before any frame. */
const THROWABLE_NAME = /(?:Exception|Error|Throwable|Failure)$/;
const OMITTED = /^\s*\.\.\.\s+(\d+)\s+(?:more|common frames omitted)\s*$/;
/** A container's log prefix, as `docker compose logs` writes it: `shop-1  | `. */
const CONTAINER_PREFIX = /^[\w.-]+\s+\|\s?/;

export function parseJavaStackTrace(text: string): JavaException[] {
  const exceptions: JavaException[] = [];
  let current: JavaException | null = null;
  // Depth counts from the first header's indentation, so a trace pasted with every line indented reads the same.
  let base: number | null = null;
  for (const line of traceLines(text)) {
    // A header first: its message may itself read like a frame (`failed at com.example.Order.total(Order.java:42)`).
    const header = headerOf(line, current, base ?? 0);
    if (header !== null) {
      base ??= header.indent;
      current = header.exception;
      exceptions.push(current);
      continue;
    }
    const frame = javaFrame(line);
    if (frame !== null) {
      if (current === null) {
        current = { kind: "thrown", type: null, depth: 0, frames: [], omitted: 0 };
        exceptions.push(current);
      }
      current.frames.push(frame);
      continue;
    }
    const omitted = OMITTED.exec(line);
    if (omitted?.[1] !== undefined && current !== null) current.omitted += Number(omitted[1]);
  }
  // A line such as `com.example.Shop: started` from the log before the trace reads like a header; only a real exception
  // keeps one without frames.
  return exceptions.filter((e) => e.frames.length > 0 || e.omitted > 0 || e.kind !== "thrown" || THROWABLE_NAME.test(e.type ?? ""));
}

/**
 * The trace's lines without a container's log prefix; a trace copied from a log viewer as one line with `\n` and `\t`
 * written out gets its line breaks back.
 */
function traceLines(text: string): string[] {
  const unescaped = /\r?\n/.test(text) ? text : text.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
  return unescaped.split(/\r?\n/).map((line) => line.replace(CONTAINER_PREFIX, ""));
}

/**
 * An exception that starts at `line`. A top-level header whose name does not say it is a throwable opens one only before
 * any frame: after frames it is a line of the message or the log (`com.example.Bar: oops`), not a new trace.
 */
function headerOf(line: string, current: JavaException | null, base: number): { exception: JavaException; indent: number } | null {
  const match = HEADER.exec(line);
  const [, indent = "", prefix, type] = match ?? [];
  if (type === undefined) return null;
  const kind = headerKind(prefix);
  if (kind === "thrown" && current !== null && current.frames.length > 0 && !THROWABLE_NAME.test(type)) return null;
  const tabs = tabsOf(indent);
  const depth = kind === "thrown" ? 0 : indentDepth(Math.max(0, tabs - base), kind, current);
  return { exception: { kind, type, depth, frames: [], omitted: 0 }, indent: tabs };
}

/**
 * The JVM indents a suppressed exception one tab deeper than its owner's frames, and its causes as deep as itself; the main
 * chain's `Caused by:` starts the line.
 */
function indentDepth(tabs: number, kind: JavaExceptionKind, current: JavaException | null): number {
  if (kind === "suppressed") return Math.max(1, tabs);
  if (tabs === 0) return 0;
  return current?.depth ?? tabs;
}

/** Indentation in tab stops: a tab, or four spaces. */
function tabsOf(indent: string): number {
  return indent.replaceAll("    ", "\t").replaceAll(" ", "").length;
}

function javaFrame(line: string): JavaFrame | null {
  const match = FRAME.exec(line);
  const [, className, method, place] = match ?? [];
  if (className === undefined || method === undefined || place === undefined) return null;
  const at = PLACE.exec(place.trim());
  const file = at?.[1] ?? null;
  return { className, method, file, line: at?.[2] === undefined ? null : Number(at[2]) };
}

function headerKind(prefix: string | undefined): JavaExceptionKind {
  if (prefix === "Caused by") return "caused_by";
  if (prefix === "Suppressed") return "suppressed";
  if (prefix === "Wrapped by") return "wrapped_by";
  return "thrown";
}

/**
 * The index of the root cause: the main chain's last `Caused by:` (not a suppressed exception's own cause), or with
 * logback's `%rEx`, which prints the root cause first and then `Wrapped by:`, the first exception; `-1` without a cause.
 */
export function rootCause(exceptions: readonly JavaException[]): number {
  if (exceptions.some((e) => e.kind === "wrapped_by" && e.depth === 0)) return exceptions.findIndex((e) => e.kind === "thrown");
  return exceptions.findLastIndex((e) => e.kind === "caused_by" && e.depth === 0);
}

/**
 * The trace shortened to `max` characters for the prompt, keeping every line that is not a frame (the headers, every
 * `Caused by:` with the root cause at the bottom, the `... N more`) and fewer frames of each exception until it fits; a
 * trace still too long is cut at the end. The frames are mapped from the whole trace, so only the quote is shorter.
 */
export function shortenedTrace(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = traceLines(text);
  for (const kept of [20, 10, 5, 2, 0]) {
    const shortened = keepFrames(lines, kept).join("\n");
    if (shortened.length <= max) return shortened;
  }
  const note = "\n[the rest of the stack trace was left out]";
  return `${keepFrames(lines, 0)
    .join("\n")
    .slice(0, max - note.length)}${note}`;
}

/** The lines with at most `kept` frames in a row, the rest of a run said in one line. */
function keepFrames(lines: readonly string[], kept: number): string[] {
  const out: string[] = [];
  let run = 0;
  const closeRun = () => {
    if (run > kept) out.push(`\t... ${run - kept} frames left out by Trackwall`);
    run = 0;
  };
  for (const line of lines) {
    if (javaFrame(line) !== null && HEADER.exec(line) === null) {
      run += 1;
      if (run <= kept) out.push(line);
      continue;
    }
    closeRun();
    out.push(line);
  }
  closeRun();
  return out;
}
