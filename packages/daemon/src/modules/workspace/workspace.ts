import type {
  Commit,
  FileContent,
  Repo,
  RepoList,
  RepoOverview,
  RepoStatus,
  RepoStatusOk,
  TreeEntry,
  WorkspaceSettings,
} from "@trackwall/protocol";
import { DomainError } from "../../errors.ts";
import { vscodeUrl } from "./editor-url.ts";
import { mapLimit } from "./map-limit.ts";
import { findRepos, type RepoEntry, resolveProjectsDir } from "./projects-dir.ts";
import type { WorkspaceFile } from "./workspace-file.ts";

/**
 * Moduł `workspace` (§4): repo z folderu z projektami wskazanego w `workspace.yaml` (ADR-18) i ich stan
 * zaobserwowany w gicie. Ani lista, ani stan nie są nigdzie zapisywane; każde zapytanie czyta folder i pyta gita,
 * więc nie rozjeżdżają się z tym, co robi użytkownik.
 */

/** Ile commitów pokazuje przegląd repo. */
const OVERVIEW_COMMITS = 30;
/** Limit podglądu pliku i README: więcej i tak nikt nie przewija w panelu. */
const PREVIEW_MAX_BYTES = 512 * 1024;
const README = /^readme(\.(md|markdown|txt|rst|adoc))?$/i;
/**
 * Ile repo naraz pyta gita przy liście: folder z projektami może mieć ich setki, a każde to dwa procesy `git`,
 * na Windowsie drogie w starcie i skanowane przez antywirus.
 */
const STATUS_CONCURRENCY = 8;

/** Czego `workspace` potrzebuje od `vcs`; podłączane w fasadzie (§4: moduły nie importują się nawzajem). */
interface WorkspaceVcs {
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

  async list(): Promise<RepoList> {
    const { projectsDir, entries } = await this.entries();
    return { projectsDir, repos: await mapLimit(entries, STATUS_CONCURRENCY, (entry) => this.describe(entry)) };
  }

  settings(): WorkspaceSettings {
    return { projectsDir: this.deps.file.projectsDir(), configFile: this.deps.file.path };
  }

  setProjectsDir(path: string): WorkspaceSettings {
    this.deps.file.setProjectsDir(resolveProjectsDir(path));
    return this.settings();
  }

  async overview(id: string): Promise<RepoOverview> {
    const entry = await this.entry(id);
    const [commits, readme] = await this.inRepo(entry, () =>
      Promise.all([this.deps.vcs.log(entry.path, OVERVIEW_COMMITS), this.readme(entry.path)]),
    );
    return { readme, commits };
  }

  async tree(id: string, path: string): Promise<TreeEntry[]> {
    const entry = await this.entry(id);
    const entries = await this.inRepo(entry, () => this.deps.vcs.tree(entry.path, path));
    if (!entries) throw new DomainError("not_found", `w ${id} nie ma katalogu "${path}" w ostatnim commicie`);
    return entries;
  }

  async file(id: string, path: string): Promise<FileContent> {
    const entry = await this.entry(id);
    const content = await this.inRepo(entry, () => this.deps.vcs.file(entry.path, path, PREVIEW_MAX_BYTES));
    if (!content) throw new DomainError("not_found", `w ${id} nie ma pliku "${path}" w ostatnim commicie`);
    return content;
  }

  /** Daemon nie wie, czy system obsłużył adres; wynik to tylko potwierdzenie przyjęcia. */
  async openEditor(id: string): Promise<void> {
    this.deps.openUrl(vscodeUrl((await this.entry(id)).path));
  }

  /** Bez ustawionego folderu z projektami nie ma repo. */
  private async entries(): Promise<{ projectsDir: string | null; entries: RepoEntry[] }> {
    const projectsDir = this.deps.file.projectsDir();
    return { projectsDir, entries: projectsDir === null ? [] : await findRepos(projectsDir) };
  }

  private async entry(id: string): Promise<RepoEntry> {
    const entry = (await this.entries()).entries.find((r) => r.id === id);
    if (!entry) throw new DomainError("not_found", `w folderze z projektami nie ma repo "${id}"`);
    return entry;
  }

  private async describe(entry: RepoEntry): Promise<Repo> {
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
  private async inRepo<T>(entry: RepoEntry, readFromGit: () => Promise<T>): Promise<T> {
    try {
      return await readFromGit();
    } catch (err) {
      throw new DomainError("repo_unavailable", `${entry.id}: ${messageOf(err)}`);
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
