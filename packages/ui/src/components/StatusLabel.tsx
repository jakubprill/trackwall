import type { StatusLabel as StatusLabelProps } from "@trackwall/protocol";
import { STATUS_DOT_CLASS, statusTextClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/** What a hollow dot means, on hover (ADR-261). */
const GUESS_TITLE = "A guess from what Copilot CLI shows, not yet confirmed by its hooks";

/**
 * A glowing state dot with text; the dot repeats the text, so a screen reader skips it. A guess (ADR-261) has a hollow
 * dot and says so on hover. A state without a tone (for example stopped by the user) is muted text without a dot.
 * `labelClassName` lets a narrow place hide the text and keep the dot; `className` lets a place that wraps let the text
 * wrap too, instead of keeping it on one line.
 */
export function StatusLabel({
  tone,
  label,
  guess,
  labelClassName,
  className,
}: StatusLabelProps & { labelClassName?: string; className?: string }) {
  const title = guess ? GUESS_TITLE : undefined;
  if (!tone)
    return (
      <span className={cn(statusTextClass(tone), className)} title={title}>
        {label}
      </span>
    );
  return (
    <span className={cn("flex shrink-0 items-center gap-2", statusTextClass(tone), className)} title={title}>
      <span
        aria-hidden
        className={cn("inline-block size-1.5 shrink-0 rounded-full", guess ? "border border-current" : STATUS_DOT_CLASS[tone])}
      />
      <span className={labelClassName}>{label}</span>
    </span>
  );
}
