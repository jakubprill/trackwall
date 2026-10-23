import type { StatusTone } from "@/lib/repo-status";
import { cn } from "@/lib/utils";

const TONES: Record<StatusTone, { dot: string; text: string }> = {
  ok: { dot: "bg-success shadow-glow-success", text: "" },
  warning: { dot: "bg-warning shadow-glow-warning", text: "text-warning" },
  error: { dot: "bg-destructive shadow-glow-destructive", text: "text-destructive" },
};

/** Świecąca kropka stanu z tekstem; kropka powtarza tekst, więc czytnik ekranu ją pomija. */
export function StatusLabel({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-2", TONES[tone].text)}>
      <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", TONES[tone].dot)} />
      {label}
    </span>
  );
}
