import type { BuildFile, CardProblem, Consumed, ConsumedPackage, Evidence, Provided, ProvidedPackage, ToolRequirement } from "@trackwall/protocol";

/**
 * Commit widziany przez ekstraktory: lista plików i treść plików buildu i konfiguracji, przeczytana z gita jednym
 * procesem przed ekstrakcją (`read-snapshot.ts`). Ekstraktory są czystymi funkcjami na tym obiekcie, więc testuje się
 * je bez gita. Ścieżki jak w `repo-path.ts`.
 */
export interface RepoSnapshot {
  commit: string;
  /** Pliki commita poza katalogami zależności (`SKIPPED_DIRS` w `read-snapshot.ts`). */
  paths: readonly string[];
  /** Treść pliku; `undefined`, gdy go nie ma albo nie był czytany (nie jest plikiem buildu ani konfiguracji). */
  text(path: string): string | undefined;
  /** Czego odczyt commita nie dał rady przeczytać (limity); trafia na kartę razem z problemami ekstraktorów. */
  problems: readonly CardProblem[];
}

/** Co ekstraktor wnosi do karty; ekstraktory buildu dają paczki, ekstraktory HTTP aplikacje, endpointy i klientów. */
export interface Extracted<P extends Provided = ProvidedPackage, C extends Consumed = ConsumedPackage> {
  buildFiles: BuildFile[];
  provides: P[];
  consumes: C[];
  tools: ToolRequirement[];
  problems: CardProblem[];
}

/** Miejsce na problemy karty dla odczytu, który nie daje innych faktów (katalog wersji, konfiguracja Spring). */
export type ProblemSink = Pick<Extracted, "problems">;

export function emptyExtracted<P extends Provided = ProvidedPackage, C extends Consumed = ConsumedPackage>(): Extracted<P, C> {
  return { buildFiles: [], provides: [], consumes: [], tools: [], problems: [] };
}

/** Dowód: plik i pierwsza linia pasująca do `pattern` (`null`, gdy żadna nie pasuje). */
export function evidenceAt(path: string, text: string, pattern: RegExp): Evidence {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  return { path, line: index < 0 ? null : index + 1 };
}

/**
 * Linia (od 1) pierwszego wystąpienia każdego klucza, który wyrażenie `key` (z flagą `g`) łapie w pierwszej pasującej
 * grupie (alternatywy dla klucza w cudzysłowie i bez). Jedno
 * przejście przez plik zamiast szukania osobno dla każdej zależności: plik z dziesiątkami tysięcy kluczy dawałby czas
 * kwadratowy, a plik jest niezaufany (§8).
 */
export function keyLines(text: string, key: RegExp): Map<string, number> {
  const lines = new Map<string, number>();
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(key)) {
      const name = m.slice(1).find((group) => group !== undefined);
      if (name !== undefined && !lines.has(name)) lines.set(name, i + 1);
    }
  });
  return lines;
}
