import { cn } from "@/lib/utils";

const TONES = {
  ok: "bg-success shadow-[0_0_6px_var(--success)]",
  warning: "bg-warning shadow-[0_0_6px_var(--warning)]",
  error: "bg-destructive shadow-[0_0_6px_var(--destructive)]",
  idle: "bg-muted-foreground",
};

export type StatusTone = keyof typeof TONES;

/**
 * Świecąca kropka stanu. Bez `label` powtarza tekst stojący obok i czytnik ekranu ją pomija;
 * z `label` jest jedynym nośnikiem informacji, więc ma ją w `aria-label` i podpowiedzi.
 */
export function StatusDot({ tone, label, className }: { tone: StatusTone; label?: string; className?: string }) {
  const dot = cn("inline-block size-1.5 shrink-0 rounded-full", TONES[tone], className);
  if (!label) return <span aria-hidden className={dot} />;
  return <span role="img" aria-label={label} title={label} className={dot} />;
}
