import type { BuildFile, CardProblem, ConsumedPackage, Evidence, ProvidedPackage, ToolRequirement } from "@trackwall/protocol";

/**
 * Commit widziany przez ekstraktory: lista wszystkich plików i treść plików buildu i konfiguracji, przeczytana z gita
 * jednym procesem przed ekstrakcją (`read-snapshot.ts`). Ekstraktory są czystymi funkcjami na tym obiekcie, więc
 * testuje się je bez gita. Ścieżki zawsze z `/`, jak w gicie, względne do korzenia repo.
 */
export interface RepoSnapshot {
  commit: string;
  /** Wszystkie pliki commita. */
  paths: readonly string[];
  /** Treść pliku; `undefined`, gdy go nie ma albo nie był czytany (nie jest plikiem buildu ani konfiguracji). */
  text(path: string): string | undefined;
}

/** Co ekstraktor jednego systemu budowania wnosi do karty. */
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

/** Katalog ścieżki w repo; `""` dla korzenia. */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Ścieżka `rel` względem katalogu `dir`, z rozwiązanymi `.` i `..`; `undefined`, gdy wychodzi poza repo albo jest
 * bezwzględna (moduł Maven poza repo nie jest częścią tego repo).
 */
export function joinPath(dir: string, rel: string): string | undefined {
  const normalized = rel.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return undefined;
  const parts = dir === "" ? [] : dir.split("/");
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.pop() === undefined) return undefined;
    } else parts.push(segment);
  }
  return parts.join("/");
}

/** Ścieżka pliku `name` w katalogu `dir`. */
export function inDir(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Czy `path` leży w katalogu `dir` albo głębiej (`dir` `""` to korzeń, w którym leży wszystko). */
export function isUnder(path: string, dir: string): boolean {
  return dir === "" || path.startsWith(`${dir}/`);
}

/**
 * Pliki buildu bez pliku tego samego rodzaju w żadnym katalogu nadrzędnym: korzenie buildów. Plik głębiej należy
 * do buildu korzenia tylko wtedy, gdy korzeń go wymienia (moduł, paczka workspace), więc `pom.xml` z fixture'ów testów
 * nie trafia na kartę.
 */
export function rootFiles(files: readonly string[]): string[] {
  const dirs = files.map(dirOf);
  return files.filter((file) => {
    const dir = dirOf(file);
    return !dirs.some((other) => other !== dir && (other === "" || dir.startsWith(`${other}/`)));
  });
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
