import type { StatusTone } from "./repo-status.ts";

/** Świecąca kropka stanu dla tonu; stan bez tonu kropki nie ma. */
export const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  ok: "bg-success shadow-glow-success",
  warning: "bg-warning shadow-glow-warning",
  error: "bg-destructive shadow-glow-destructive",
};

/**
 * Kolor tekstu stanu dla tonu (ADR-16): razem z kropką jedno miejsce dla `StatusLabel` i podpisów na scenie pulpitu. Stan bez tonu
 * (np. zatrzymany przez użytkownika) jest wyciszony, a „ok” bierze kolor otoczenia.
 */
export function statusTextClass(tone: StatusTone | undefined): string {
  if (tone === "warning") return "text-warning";
  if (tone === "error") return "text-destructive";
  return tone === "ok" ? "" : "text-muted-foreground";
}
