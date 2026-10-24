import type { StatusTone } from "@/lib/repo-status";
import { STATUS_DOT_CLASS, statusTextClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/**
 * Świecąca kropka stanu z tekstem; kropka powtarza tekst, więc czytnik ekranu ją pomija. Stan bez tonu (np. zatrzymany
 * przez użytkownika) to wyciszony tekst bez kropki.
 */
export function StatusLabel({ tone, label }: { tone?: StatusTone; label: string }) {
  if (!tone) return <span className={statusTextClass(tone)}>{label}</span>;
  return (
    <span className={cn("flex shrink-0 items-center gap-2", statusTextClass(tone))}>
      <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[tone])} />
      {label}
    </span>
  );
}
