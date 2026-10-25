import type { StatusTone } from "./repo-status.ts";

/** The glowing state dot for a tone; a state without a tone has no dot. */
export const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  ok: "bg-success shadow-glow-success",
  warning: "bg-warning shadow-glow-warning",
  error: "bg-destructive shadow-glow-destructive",
};

/**
 * The state text colour for a tone (ADR-16): together with the dot one place for `StatusLabel` and the captions on the
 * dashboard scene. A state without a tone (for example stopped by the user) is muted, and "ok" takes the surrounding colour.
 */
export function statusTextClass(tone: StatusTone | undefined): string {
  if (tone === "warning") return "text-warning";
  if (tone === "error") return "text-destructive";
  return tone === "ok" ? "" : "text-muted-foreground";
}
