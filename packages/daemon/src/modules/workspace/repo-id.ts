import { basename } from "node:path";

/**
 * Identyfikator repo z nazwy katalogu, liczony przy każdym odczycie folderu z projektami: małe litery bez polskich
 * znaków, pozostałe znaki spoza `[a-z0-9._-]` zamienione na `-`, a przy kolizji z identyfikatorem z `taken`
 * (repo wcześniej w kolejności) przyrostek `-2`, `-3`…
 */
export function repoIdFor(dir: string, taken: ReadonlySet<string>): string {
  const base =
    basename(dir)
      // `ł` nie rozkłada się w NFKD na literę i znak diakrytyczny.
      .replace(/ł/g, "l")
      .replace(/Ł/g, "L")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/, "")
      .slice(0, 60) || "repo";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
