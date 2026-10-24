import type { LogLevel } from "@trackwall/protocol";

/**
 * Record level from the line text (§4.2), until there is an ECS parser. What counts are upper-case words, as in Spring,
 * Maven and Gradle logs (`ERROR`, `[WARNING]`), `error:` / `warning:` at the start of a line as in rustc, `npm ERR!` /
 * `npm error`, and compiler diagnostics with a file location (javac `Foo.java:10: error:`, tsc
 * `a.ts(3,5): error TS2322:`, kotlinc `e: file.kt:3:5`). The stream does not decide: many tools write ordinary
 * progress to stderr. The task prefix mise puts before the lines of dependencies (`[build] `) does not change the level.
 */

const RULES: readonly [LogLevel, RegExp][] = [
  ["error", /\b(ERROR|FATAL|SEVERE)\b|\bERR!|^\s*([Ee]rror|[Ff]atal)\b|:\d+(:\d+)?: error:|\(\d+,\d+\): error TS\d+|^e: |^npm error\b/],
  ["warn", /\b(WARN|WARNING)\b|^\s*[Ww]arn(ing)?\b|:\d+(:\d+)?: warning:|^w: |^npm warn\b/],
  ["debug", /\bDEBUG\b/],
  ["trace", /\bTRACE\b/],
];

/** `[name] ` at the start of a line, unless the name is a level as in Maven (`[ERROR]`, `[INFO]`). */
const MISE_TASK_PREFIX = /^\[(?!(?:ERROR|FATAL|WARN|WARNING|INFO|DEBUG|TRACE)\])[\w:./-]+\] /;

export function logLevel(msg: string): LogLevel {
  const line = withoutTaskPrefix(msg);
  return RULES.find(([, pattern]) => pattern.test(line))?.[0] ?? "info";
}

/** The line without the mise task prefix, so rules anchored at the start of the line see the tool's text. */
export function withoutTaskPrefix(msg: string): string {
  return msg.replace(MISE_TASK_PREFIX, "");
}
