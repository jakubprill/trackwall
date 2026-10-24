import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Katalog zmyślonych repo sklepu (`test/fixtures/spring`, opis w jego README). */
const SPRING_FIXTURES = join(import.meta.dir, "..", "fixtures", "spring");

/**
 * Pliki repo z fixture'a jako ścieżka w repo (z `/`, jak w gicie) → treść, w kolejności gita (bajtowo po ścieżce):
 * kolejność `readdirSync` zależy od systemu plików, a karta wymienia klientów w kolejności plików.
 */
export function fixtureFiles(repo: string): Record<string, string> {
  const root = join(SPRING_FIXTURES, repo);
  const paths = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, ...path.split("/")), "utf8")]));
}
