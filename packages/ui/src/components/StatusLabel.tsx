import type { StatusTone } from "@/lib/repo-status";
import { STATUS_DOT_CLASS, statusTextClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/**
 * A glowing state dot with text; the dot repeats the text, so a screen reader skips it. A state without a tone (for
 * example stopped by the user) is muted text without a dot. `labelClassName` lets a narrow place hide the text and
 * keep the dot.
 */
export function StatusLabel({ tone, label, labelClassName }: { tone?: StatusTone; label: string; labelClassName?: string }) {
  if (!tone) return <span className={statusTextClass(tone)}>{label}</span>;
  return (
    <span className={cn("flex shrink-0 items-center gap-2", statusTextClass(tone))}>
      <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[tone])} />
      <span className={labelClassName}>{label}</span>
    </span>
  );
}
