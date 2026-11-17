import type { StatusTone } from "@/lib/repo-status";
import { STATUS_DOT_CLASS, statusTextClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/**
 * A glowing state dot with text; the dot repeats the text, so a screen reader skips it. A state without a tone (for
 * example stopped by the user) is muted text without a dot. `labelClassName` lets a narrow place hide the text and
 * keep the dot; `className` lets a place that wraps let the text wrap too, instead of keeping it on one line.
 */
export function StatusLabel({
  tone,
  label,
  labelClassName,
  className,
}: {
  tone?: StatusTone;
  label: string;
  labelClassName?: string;
  className?: string;
}) {
  if (!tone) return <span className={cn(statusTextClass(tone), className)}>{label}</span>;
  return (
    <span className={cn("flex shrink-0 items-center gap-2", statusTextClass(tone), className)}>
      <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[tone])} />
      <span className={labelClassName}>{label}</span>
    </span>
  );
}
