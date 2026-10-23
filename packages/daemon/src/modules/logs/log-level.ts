import type { LogLevel } from "@trackwall/protocol";

/**
 * Poziom rekordu z treści linii (§4.2), dopóki nie ma parsera ECS. Liczą się słowa pisane wielkimi literami, jak
 * w logach Springa, Mavena i Gradle (`ERROR`, `[WARNING]`), oraz `error:` / `warning:` na początku linii, jak
 * w kompilatorach (tsc, javac, rustc) i `npm ERR!`. Strumień nie decyduje: wiele narzędzi pisze zwykły postęp na stderr.
 */

const RULES: readonly [LogLevel, RegExp][] = [
  ["error", /\b(ERROR|FATAL|SEVERE)\b|\bERR!|^\s*([Ee]rror|[Ff]atal)\b/],
  ["warn", /\b(WARN|WARNING)\b|^\s*[Ww]arn(ing)?\b/],
  ["debug", /\bDEBUG\b/],
  ["trace", /\bTRACE\b/],
];

export function logLevel(msg: string): LogLevel {
  return RULES.find(([, pattern]) => pattern.test(msg))?.[0] ?? "info";
}
