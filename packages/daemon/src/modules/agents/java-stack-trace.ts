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

/** `thrown` the exception the trace starts with; `caused_by` and `suppressed` the ones under it. */
type JavaExceptionKind = "thrown" | "caused_by" | "suppressed";

export interface JavaException {
  kind: JavaExceptionKind;
  /** The exception's class, `java.lang.IllegalStateException`; `null` for frames pasted without the line that names it. */
  type: string | null;
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
/** `java.lang.IllegalStateException: message`, after `Caused by: `, `Suppressed: ` or `Exception in thread "main" `. */
const HEADER =
  /^\s*(?:Exception in thread "[^"]*"\s+)?(?:(Caused by|Suppressed):\s+)?((?:[\p{L}_$][\p{L}\p{N}_$]*\.)+[\p{L}_$][\p{L}\p{N}_$]*)(?::|\s*$)/u;
/** A class name that says it is a throwable, for a header that no frame follows. */
const THROWABLE_NAME = /(?:Exception|Error|Throwable)$/;
const OMITTED = /^\s*\.\.\.\s+(\d+)\s+(?:more|common frames omitted)\s*$/;

export function parseJavaStackTrace(text: string): JavaException[] {
  const exceptions: JavaException[] = [];
  let current: JavaException | null = null;
  for (const line of text.split(/\r?\n/)) {
    // A header first: its message may itself read like a frame (`failed at com.example.Order.total(Order.java:42)`).
    const header = HEADER.exec(line);
    if (header?.[2] !== undefined) {
      current = { kind: headerKind(header[1]), type: header[2], frames: [], omitted: 0 };
      exceptions.push(current);
      continue;
    }
    const frame = javaFrame(line);
    if (frame !== null) {
      if (current === null) {
        current = { kind: "thrown", type: null, frames: [], omitted: 0 };
        exceptions.push(current);
      }
      current.frames.push(frame);
      continue;
    }
    const omitted = OMITTED.exec(line);
    if (omitted?.[1] !== undefined && current !== null) current.omitted += Number(omitted[1]);
  }
  // A line such as `com.example.Shop: started` from the log around the trace reads like a header; only a real exception
  // keeps one without frames.
  return exceptions.filter((e) => e.frames.length > 0 || e.omitted > 0 || e.kind !== "thrown" || THROWABLE_NAME.test(e.type ?? ""));
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
  return "thrown";
}
