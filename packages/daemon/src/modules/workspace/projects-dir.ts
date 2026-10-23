import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoId } from "@trackwall/protocol";
import { DomainError } from "../../errors.ts";
import { repoIdFor } from "./repo-id.ts";

/**
 * Folder z projektami (§4.5, ADR-18): repo to każdy bezpośredni podkatalog z `.git` (katalogiem albo plikiem,
 * jak w worktree). Folder jest czytany przy każdym zapytaniu, więc repo sklonowane albo usunięte poza Trackwallem
 * pojawia się i znika bez odświeżania konfiguracji. Głębiej nie szukamy: skan zostaje tani i przewidywalny.
 */

export interface RepoEntry {
  id: RepoId;
  /** Pełna ścieżka katalogu repo. */
  path: string;
}

/** Repo w folderze z projektami, posortowane po nazwie katalogu; identyfikator z nazwy, przy kolizji z przyrostkiem. */
export function findRepos(projectsDir: string): RepoEntry[] {
  const taken = new Set<string>();
  return (
    listDir(projectsDir)
      .filter((entry) => !entry.name.startsWith(".") && isDirectory(projectsDir, entry))
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(projectsDir, name, ".git")))
      // Kolejność `readdir` zależy od systemu plików; stała kolejność daje stałe przyrostki przy kolizjach.
      .sort(byName)
      .map((name) => {
        const path = join(projectsDir, name);
        const id = repoIdFor(path, taken);
        taken.add(id);
        return { id, path };
      })
  );
}

function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new DomainError(
      "projects_dir_unavailable",
      `nie da się otworzyć folderu z projektami ${dir} (${code ?? String(err)}); sprawdź, czy istnieje, albo zmień go w ustawieniach`,
    );
  }
}

/** Dowiązanie (na Windowsie także junction) do katalogu liczy się jak katalog; zerwane dowiązanie jest pomijane. */
function isDirectory(parent: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/** Bez `localeCompare`: porządek nie może zależeć od danych ICU w Bun i Node. */
function byName(a: string, b: string): number {
  const [la, lb] = [a.toLowerCase(), b.toLowerCase()];
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
