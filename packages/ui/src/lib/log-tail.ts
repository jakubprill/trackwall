import { LOG_BUFFER_RECORDS, type LogLevel, type LogRecord, type LogTail } from "@trackwall/protocol";

/**
 * Log taska mise w UI (§4.2): rekordy z kolejnych odpowiedzi `logs/tail` sklejone w jedną listę, nie dłuższą niż
 * bufor źródła w daemonie, i kolor linii z poziomu rekordu.
 */

/** Gdy daemon zgłasza `dropped`, lista zaczyna się od nowa: między starymi a nowymi rekordami jest dziura. */
export function mergeTail(shown: LogRecord[], page: LogTail): LogRecord[] {
  if (!page.dropped && page.records.length === 0) return shown;
  const merged = page.dropped ? page.records : [...shown, ...page.records];
  return merged.slice(-LOG_BUFFER_RECORDS);
}

/** Ton tylko dla tego, co wymaga uwagi; szczegóły (`debug`, `trace`) przygaszone, reszta zwykłym tekstem. */
export function logLevelClass(level: LogLevel): string {
  if (level === "error") return "text-destructive";
  if (level === "warn") return "text-warning";
  if (level === "debug" || level === "trace") return "text-muted-foreground";
  return "";
}

/** Rekord zaczyna nowe uruchomienie, gdy poprzedni pochodzi z innego (źródło ma rekordy wielu uruchomień). */
export function startsRun(records: readonly LogRecord[], index: number): boolean {
  const previous = records[index - 1];
  return previous !== undefined && previous.runId !== records[index]?.runId;
}
