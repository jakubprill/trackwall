import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Katalog zmyślonych repo sklepu (`test/fixtures/spring`, opis w jego README). */
const SPRING_FIXTURES = join(import.meta.dir, "..", "fixtures", "spring");

/** Pliki repo z fixture'a jako ścieżka w repo (z `/`, jak w gicie) → treść. */
export function fixtureFiles(repo: string): Record<string, string> {
  const root = join(SPRING_FIXTURES, repo);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
  }
  return files;
}
