import type { BuildFile, CardProblem, ConsumedPackage, Evidence, ProvidedPackage, ToolRequirement } from "@trackwall/protocol";

/**
 * Commit widziany przez ekstraktory: lista plików i treść plików buildu i konfiguracji, przeczytana z gita jednym
 * procesem przed ekstrakcją (`read-snapshot.ts`). Ekstraktory są czystymi funkcjami na tym obiekcie, więc testuje się
 * je bez gita. Ścieżki jak w `repo-path.ts`.
 */
export interface RepoSnapshot {
  commit: string;
  /** Pliki commita poza katalogami zależności (`node_modules`). */
  paths: readonly string[];
  /** Treść pliku; `undefined`, gdy go nie ma albo nie był czytany (nie jest plikiem buildu ani konfiguracji). */
  text(path: string): string | undefined;
  /** Czego odczyt commita nie dał rady przeczytać (limity); trafia na kartę razem z problemami ekstraktorów. */
  problems: readonly CardProblem[];
}

/** Co ekstraktor wnosi do karty. */
export interface Extracted {
  buildFiles: BuildFile[];
  provides: ProvidedPackage[];
  consumes: ConsumedPackage[];
  tools: ToolRequirement[];
  problems: CardProblem[];
}

export function emptyExtracted(): Extracted {
  return { buildFiles: [], provides: [], consumes: [], tools: [], problems: [] };
}

/** Dowód: plik i pierwsza linia pasująca do `pattern` (`null`, gdy żadna nie pasuje). */
export function evidenceAt(path: string, text: string, pattern: RegExp): Evidence {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  return { path, line: index < 0 ? null : index + 1 };
}

/** `s` jako fragment wyrażenia regularnego, dosłownie. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
