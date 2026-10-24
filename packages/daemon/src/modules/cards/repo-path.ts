/**
 * Ścieżki plików w commicie (§4.6): zawsze z `/`, jak w gicie, względne do korzenia repo, więc nie przez `node:path`,
 * który na Windowsie używa `\`.
 */

/** Katalog ścieżki w repo; `""` dla korzenia. */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Nazwa pliku bez rozszerzenia (`src/main/java/a/OrderDto.java` → `OrderDto`). */
export function stemOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
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
 * nie trafia na kartę. Każdy plik sprawdza tylko swoich przodków, bo drzewo może mieć dziesiątki tysięcy plików.
 */
export function rootFiles(files: readonly string[]): string[] {
  const dirs = new Set(files.map(dirOf));
  return files.filter((file) => {
    for (let dir = dirOf(file); dir !== ""; ) {
      dir = dirOf(dir);
      if (dirs.has(dir)) return false;
    }
    return true;
  });
}
