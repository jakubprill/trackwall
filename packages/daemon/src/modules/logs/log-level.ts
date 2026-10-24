import type { LogLevel } from "@trackwall/protocol";

/**
 * Record level from the line text (§4.2), until there is an ECS parser. What counts are upper-case words, as in Spring,
 * Maven and Gradle logs (`ERROR`, `[WARNING]`), `error:` / `warning:` at the start of a line as in rustc, `npm ERR!` /
 * `npm error`, and compiler diagnostics with a file location (javac `Foo.java:10: error:`, tsc
 * `a.ts(3,5): error TS2322:`, kotlinc `e: file:///a/App.kt:3:5`). The stream does not decide: many tools write ordinary
 * progress to stderr. The task prefix mise puts before the lines of dependencies (`[build] `) does not change the level.
 */

const ERROR_WORDS = "ERROR|FATAL|SEVERE";
const WARN_WORDS = "WARN|WARNING";
const OTHER_WORDS = "INFO|DEBUG|TRACE";
/** The rest of the start of a kotlinc diagnostic after `e` or `w`: `: ` and a file (URL, absolute path or a `.kt` file). */
const KOTLINC = String.raw`: (?:file:\/\/|\/|[A-Za-z]:\\|\S+\.kts?\b)`;

const RULES: readonly [LogLevel, RegExp][] = [
  [
    "error",
    new RegExp(
      String.raw`\b(${ERROR_WORDS})\b|\bERR!|^\s*([Ee]rror|[Ff]atal)\b|:\d+(:\d+)?: error:|\(\d+,\d+\): error TS\d+|^e${KOTLINC}|^npm error\b`,
    ),
  ],
  ["warn", new RegExp(String.raw`\b(${WARN_WORDS})\b|^\s*[Ww]arn(ing)?\b|:\d+(:\d+)?: warning:|^w${KOTLINC}|^npm warn\b`)],
  ["debug", /\bDEBUG\b/],
  ["trace", /\bTRACE\b/],
];

/**
 * A level tag at the start of a line without a timestamp, repeated on every line of one message (Maven `[ERROR]`,
 * `npm error`).
 */
export const LEVEL_TAG = new RegExp(String.raw`^(?:\[(?:${ERROR_WORDS}|${WARN_WORDS})\]|npm (?:ERR!|error|warn))`);

const LEVEL_WORDS = `${ERROR_WORDS}|${WARN_WORDS}|${OTHER_WORDS}`;
/**
 * `[name] ` at the start of a line, unless it is a level: an upper-case level word alone or with a thread or logger
 * (`[ERROR]`, `[ERROR:main]`, `[WARN/worker]`) or a lower-case one alone, as in sbt (`[info]`). A mise task named
 * exactly like a lower-case level (`debug`) therefore keeps its prefix; `debug-server` or `info:docs` lose it.
 */
const MISE_TASK_PREFIX = new RegExp(String.raw`^\[(?!(?:${LEVEL_WORDS})[\]:/]|(?:${LEVEL_WORDS.toLowerCase()})\])[\w:./-]+\] `);

export function logLevel(msg: string): LogLevel {
  const line = withoutTaskPrefix(msg);
  return RULES.find(([, pattern]) => pattern.test(line))?.[0] ?? "info";
}

/** The line without the mise task prefix, so rules anchored at the start of the line see the tool's text. */
export function withoutTaskPrefix(msg: string): string {
  return msg.replace(MISE_TASK_PREFIX, "");
}
