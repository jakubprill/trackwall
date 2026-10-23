import { type Dirent, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path, { join, type PlatformPath, resolve } from "node:path";
import type { RepoId } from "@trackwall/protocol";
import { DomainError } from "../../errors.ts";
import { repoIdFor } from "./repo-id.ts";

/**
 * Folder z projektami (§4.5, ADR-18): repo to każdy bezpośredni podkatalog z `.git` (katalogiem albo plikiem,
 * jak w worktree). Folder jest czytany przy każdym zapytaniu, więc repo sklonowane albo usunięte poza Trackwallem
 * pojawia się i znika bez odświeżania konfiguracji. Głębiej nie szukamy: skan zostaje tani i przewidywalny.
 * Odczyt jest asynchroniczny, bo folder bywa na dysku sieciowym albo uśpionym dysku zewnętrznym.
 */

export interface RepoEntry {
  id: RepoId;
  /** Pełna ścieżka katalogu repo. */
  path: string;
}

/**
 * Pełna ścieżka: na Windowsie z literą dysku albo UNC. `\projekty` jest dla `isAbsolute` pełna, ale wskazuje
 * dysk, z którego akurat uruchomiono daemon; `~` nie jest rozwijane, a względna zależy od katalogu daemona.
 */
export function isFullPath(p: string, paths: PlatformPath = path): boolean {
  return paths.isAbsolute(p) && (paths.sep === "/" || paths.parse(p).root.length > 1);
}

/** Pełna ścieżka folderu do zapisu w `workspace.yaml`; musi istnieć, żeby literówka nie dała po cichu pustej listy. */
export function resolveProjectsDir(input: string): string {
  if (!isFullPath(input)) throw new DomainError("bad_request", `podaj pełną ścieżkę do folderu z projektami, dostałem "${input}"`);
  const dir = resolve(input);
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch (err) {
    // Nie tylko ENOENT: ENOTDIR, EACCES i zbyt długa nazwa to też zła ścieżka od użytkownika, nie błąd daemona.
    throw new DomainError("bad_request", `${dir} nie istnieje albo nie da się go otworzyć (${errorCode(err)})`);
  }
  if (!isDir) throw new DomainError("bad_request", `${dir} nie jest folderem`);
  return dir;
}

/**
 * Repo w folderze z projektami, posortowane po nazwie katalogu; identyfikator z nazwy, przy kolizji z przyrostkiem
 * w tej samej kolejności (nowy katalog, który sortuje się wcześniej, może więc przejąć identyfikator, ADR-18).
 */
export async function findRepos(projectsDir: string): Promise<RepoEntry[]> {
  const entries = (await listDir(projectsDir)).filter((entry) => !entry.name.startsWith("."));
  const isRepo = await Promise.all(entries.map((entry) => isRepoDir(projectsDir, entry)));
  const taken = new Set<string>();
  return (
    entries
      .filter((_, i) => isRepo[i])
      .map((entry) => entry.name)
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

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new DomainError(
      "projects_dir_unavailable",
      `nie da się otworzyć folderu z projektami ${dir} (${errorCode(err)}); sprawdź, czy istnieje, albo zmień go w ustawieniach`,
    );
  }
}

/** Dowiązanie (na Windowsie także junction) do katalogu liczy się jak katalog; zerwane dowiązanie jest pomijane. */
async function isRepoDir(parent: string, entry: Dirent): Promise<boolean> {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
  const dir = join(parent, entry.name);
  const [self, git] = await Promise.all([stat(dir).catch(() => undefined), stat(join(dir, ".git")).catch(() => undefined)]);
  return self?.isDirectory() === true && git !== undefined;
}

/** Bez `localeCompare`: porządek nie może zależeć od danych ICU w Bun i Node. */
function byName(a: string, b: string): number {
  const [la, lb] = [a.toLowerCase(), b.toLowerCase()];
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? String(err);
}
