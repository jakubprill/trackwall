import type { StatusTone } from "./repo-status.ts";

/**
 * Kolor tekstu stanu dla tonu (ADR-16): jedno miejsce dla `StatusLabel` i podpisów na scenie pulpitu. Stan bez tonu
 * (np. zatrzymany przez użytkownika) jest wyciszony, a „ok” bierze kolor otoczenia.
 */
export function statusTextClass(tone: StatusTone | undefined): string {
  if (tone === "warning") return "text-warning";
  if (tone === "error") return "text-destructive";
  return tone === "ok" ? "" : "text-muted-foreground";
}
