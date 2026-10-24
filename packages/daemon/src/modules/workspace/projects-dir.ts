import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RepoId } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { isFullPath, NOT_FULL_PATH } from "./full-path.ts";
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
 * Pełna ścieżka folderu do zapisu w `workspace.yaml`; musi istnieć, żeby literówka nie dała po cichu pustej listy.
 * Asynchronicznie, bo wskazany folder może leżeć na uśpionym dysku.
 */
export async function resolveProjectsDir(input: string): Promise<string> {
  if (!isFullPath(input)) throw new DomainError("bad_request", `${NOT_FULL_PATH}, got "${input}"`);
  const dir = resolve(input);
  let isDir: boolean;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch (err) {
    // Nie tylko ENOENT: ENOTDIR, EACCES i zbyt długa nazwa to też zła ścieżka od użytkownika, nie błąd daemona.
    throw new DomainError("bad_request", `${dir} does not exist or cannot be opened (${errorCode(err)})`);
  }
  if (!isDir) throw new DomainError("bad_request", `${dir} is not a directory`);
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

/** Klucz nazwy albo ścieżki w folderze z projektami: dyski Windowsa i macOS nie rozróżniają wielkości liter. */
export function dirKey(name: string): string {
  return name.toLowerCase();
}

/** Czy w folderze z projektami jest już coś (także plik albo ukryty katalog) o tej nazwie; klon nie może tam trafić. */
export async function takenNames(projectsDir: string): Promise<(name: string) => boolean> {
  const taken = new Set((await listDir(projectsDir)).map((entry) => dirKey(entry.name)));
  return (name) => taken.has(dirKey(name));
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new DomainError(
      "projects_dir_unavailable",
      `cannot open the projects folder ${dir} (${errorCode(err)}); check that it exists or change it in Settings`,
    );
  }
}

/** Dowiązanie (na Windowsie także junction) do katalogu liczy się jak katalog; zerwane dowiązanie jest pomijane. */
async function isRepoDir(parent: string, entry: Dirent): Promise<boolean> {
  const dir = join(parent, entry.name);
  const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(dir).catch(() => undefined))?.isDirectory() === true);
  return isDir && (await hasGit(dir));
}

/** A `.git` directory or file (as in a worktree) makes a directory a repo. */
export async function hasGit(dir: string): Promise<boolean> {
  return (await stat(join(dir, ".git")).catch(() => undefined)) !== undefined;
}

/** Bez `localeCompare`: porządek nie może zależeć od danych ICU w Bun i Node. */
function byName(a: string, b: string): number {
  const [la, lb] = [a.toLowerCase(), b.toLowerCase()];
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? String(err);
}
