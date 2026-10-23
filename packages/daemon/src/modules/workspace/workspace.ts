import { isAbsolute, resolve } from "node:path";
import type { Commit, FileContent, Repo, RepoOverview, RepoStatus, RepoStatusOk, TreeEntry } from "@pitwall/protocol";
import { DomainError } from "../../errors.ts";
import { vscodeUrl } from "./editor-url.ts";
import { repoIdFor } from "./repo-id.ts";
import { samePath } from "./same-path.ts";
import type { WorkspaceFile, WorkspaceRepoEntry } from "./workspace-file.ts";

/**
 * Moduł `workspace` (§4): lista repo z `workspace.yaml` i ich stan zaobserwowany w gicie.
 * Stan nie jest nigdzie zapisywany; każde zapytanie pyta gita, więc nie rozjeżdża się z tym, co robi użytkownik.
 */

/** Ile commitów pokazuje przegląd repo. */
const OVERVIEW_COMMITS = 30;
/** Limit podglądu pliku i README: więcej i tak nikt nie przewija w panelu. */
const PREVIEW_MAX_BYTES = 512 * 1024;
const README = /^readme(\.(md|markdown|txt|rst|adoc))?$/i;

/** Czego `workspace` potrzebuje od `vcs`; podłączane w fasadzie (§4: moduły nie importują się nawzajem). */
interface WorkspaceVcs {
  toplevel(dir: string): Promise<string>;
  status(dir: string): Promise<RepoStatusOk>;
  log(dir: string, limit: number): Promise<Commit[]>;
  tree(dir: string, path: string): Promise<TreeEntry[] | undefined>;
  file(dir: string, path: string, maxBytes: number): Promise<FileContent | undefined>;
}

export interface WorkspaceDeps {
  file: WorkspaceFile;
  vcs: WorkspaceVcs;
  /** Otwiera URL w systemie (tu: `vscode://`); w daemonie `openBrowser`. */
  openUrl: (url: string) => void;
}

export class Workspace {
  private readonly deps: WorkspaceDeps;

  constructor(deps: WorkspaceDeps) {
    this.deps = deps;
  }

  list(): Promise<Repo[]> {
    return Promise.all(this.deps.file.repos().map((entry) => this.describe(entry)));
  }

  /** Dodaje repo, w którym leży `path`. To samo repo dodane drugi raz zwraca istniejący wpis. */
  async add(path: string): Promise<Repo> {
    if (!isAbsolute(path)) throw new DomainError("bad_request", `podaj pełną ścieżkę do katalogu, dostałem "${path}"`);
    let root: string;
    try {
      root = await this.deps.vcs.toplevel(resolve(path));
    } catch (err) {
      throw new DomainError("bad_request", `${path} nie jest repozytorium gita: ${messageOf(err)}`);
    }
    const repos = this.deps.file.repos();
    const existing = repos.find((r) => samePath(r.path, root));
    if (existing) return this.describe(existing);
    const entry = { id: repoIdFor(root, new Set(repos.map((r) => r.id))), path: root };
    this.deps.file.add(entry);
    return this.describe(entry);
  }

  /** Usuwa repo tylko z listy; katalog na dysku zostaje nietknięty. */
  remove(id: string): void {
    if (!this.deps.file.remove(id)) throw notFound(id);
  }

  async overview(id: string): Promise<RepoOverview> {
    const entry = this.entry(id);
    const [commits, readme] = await this.inRepo(entry, () =>
      Promise.all([this.deps.vcs.log(entry.path, OVERVIEW_COMMITS), this.readme(entry.path)]),
    );
    return { readme, commits };
  }

  async tree(id: string, path: string): Promise<TreeEntry[]> {
    const entry = this.entry(id);
    const entries = await this.inRepo(entry, () => this.deps.vcs.tree(entry.path, path));
    if (!entries) throw new DomainError("not_found", `w ${id} nie ma katalogu "${path}" w ostatnim commicie`);
    return entries;
  }

  async file(id: string, path: string): Promise<FileContent> {
    const entry = this.entry(id);
    const content = await this.inRepo(entry, () => this.deps.vcs.file(entry.path, path, PREVIEW_MAX_BYTES));
    if (!content) throw new DomainError("not_found", `w ${id} nie ma pliku "${path}" w ostatnim commicie`);
    return content;
  }

  /** Daemon nie wie, czy system obsłużył adres; wynik to tylko potwierdzenie przyjęcia. */
  openEditor(id: string): void {
    this.deps.openUrl(vscodeUrl(this.entry(id).path));
  }

  private entry(id: string): WorkspaceRepoEntry {
    const entry = this.deps.file.repos().find((r) => r.id === id);
    if (!entry) throw notFound(id);
    return entry;
  }

  private async describe(entry: WorkspaceRepoEntry): Promise<Repo> {
    let status: RepoStatus;
    try {
      status = await this.deps.vcs.status(entry.path);
    } catch (err) {
      status = { kind: "unavailable", message: messageOf(err) };
    }
    return { ...entry, status };
  }

  private async readme(dir: string): Promise<RepoOverview["readme"]> {
    const root = (await this.deps.vcs.tree(dir, "")) ?? [];
    const candidates = root.filter((e) => e.kind === "file" && README.test(e.name));
    const best = candidates.find((e) => /\.md$/i.test(e.name)) ?? candidates[0];
    if (!best) return null;
    const content = await this.deps.vcs.file(dir, best.path, PREVIEW_MAX_BYTES);
    return content?.kind === "text" ? { path: best.path, text: content.text, truncated: content.truncated } : null;
  }

  /** Błąd gita przy czytaniu repo z listy to stan repo (`repo_unavailable`), nie błąd daemona. */
  private async inRepo<T>(entry: WorkspaceRepoEntry, readFromGit: () => Promise<T>): Promise<T> {
    try {
      return await readFromGit();
    } catch (err) {
      throw new DomainError("repo_unavailable", `${entry.id}: ${messageOf(err)}`);
    }
  }
}

function notFound(id: string): DomainError {
  return new DomainError("not_found", `w workspace nie ma repo "${id}"`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
