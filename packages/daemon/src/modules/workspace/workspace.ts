import { dirname, join } from "node:path";
import {
  type CloneJob,
  type Commit,
  type FileContent,
  type HostedRepo,
  type HostRepos,
  type RemoteRepoList,
  type Repo,
  type RepoHost,
  type RepoList,
  type RepoOverview,
  type RepoStatus,
  type RepoStatusOk,
  type SyncResult,
  type SyncRun,
  sameHost,
  type TreeEntry,
  type WorkspaceSettings,
} from "@trackwall/protocol";
import { DomainError } from "../../errors.ts";
import { CloneJobs } from "./clone-jobs.ts";
import { vscodeUrl } from "./editor-url.ts";
import { messageOf } from "./error-message.ts";
import { mapLimit } from "./map-limit.ts";
import { dirKey, findRepos, type RepoEntry, resolveProjectsDir, takenNames } from "./projects-dir.ts";
import { SyncRuns } from "./sync-runs.ts";
import type { WorkspaceFile } from "./workspace-file.ts";

/**
 * Moduł `workspace` (§4): repo z folderu z projektami wskazanego w `workspace.yaml` (ADR-18) i ich stan
 * zaobserwowany w gicie, oraz klon nowych repo z hostingów z ustawień (ADR-19). Ani lista, ani stan nie są nigdzie
 * zapisywane; każde zapytanie czyta folder i pyta gita, więc nie rozjeżdżają się z tym, co robi użytkownik.
 * Synchronizacja wszystkich repo (ADR-21) przesuwa gałęzie domyślne do zdalnych. Klonowania i synchronizacje żyją
 * tylko w pamięci, do restartu daemona.
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
/**
 * Ile repo naraz synchronizuje: fetch trzyma połączenie z hostingiem, a firmowy GitLab albo VPN potrafi
 * ograniczać liczbę równoczesnych połączeń SSH z jednego klienta.
 */
const SYNC_CONCURRENCY = 4;

/** Czego `workspace` potrzebuje od `vcs`; podłączane w fasadzie (§4: moduły nie importują się nawzajem). */
interface WorkspaceVcs {
  status(dir: string): Promise<RepoStatusOk>;
  remote(dir: string): Promise<string | null>;
  sync(dir: string): Promise<SyncResult>;
  log(dir: string, limit: number): Promise<Commit[]>;
  tree(dir: string, path: string): Promise<TreeEntry[] | undefined>;
  file(dir: string, path: string, maxBytes: number): Promise<FileContent | undefined>;
}

/** Czego `workspace` potrzebuje od hostingów repo z modułu `vcs` (ADR-19). */
interface WorkspaceHosting {
  repos(host: RepoHost, query: string): Promise<{ repos: HostedRepo[]; truncated: boolean }>;
  clone(host: RepoHost, fullName: string, dest: string): Promise<void>;
}

export interface WorkspaceDeps {
  file: WorkspaceFile;
  vcs: WorkspaceVcs;
  hosting: WorkspaceHosting;
  /** Otwiera URL w systemie (tu: `vscode://`); w daemonie `openBrowser`. */
  openUrl: (url: string) => void;
}

export class Workspace {
  private readonly deps: WorkspaceDeps;
  private readonly clones = new CloneJobs();
  private readonly syncs = new SyncRuns();

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

  async setProjectsDir(path: string): Promise<WorkspaceSettings> {
    this.deps.file.setProjectsDir(await resolveProjectsDir(path));
    return this.settings();
  }

  repoHosts(): RepoHost[] {
    return this.deps.file.repoHosts();
  }

  setRepoHosts(hosts: RepoHost[]): RepoHost[] {
    this.deps.file.setRepoHosts(hosts);
    return this.repoHosts();
  }

  /**
   * Repo pasujące do `query` z każdego hostingu naraz; hosting, który nie odpowiada, nie zabiera listy pozostałych.
   */
  async remoteRepos(query: string): Promise<RemoteRepoList> {
    const projectsDir = this.deps.file.projectsDir();
    const taken = projectsDir === null ? () => false : await takenNames(projectsDir);
    const hosts = await Promise.all(this.deps.file.repoHosts().map((host) => this.hostRepos(host, query, taken)));
    return { projectsDir, hosts };
  }

  /**
   * Zaczyna klon `fullName` do folderu z projektami, do katalogu o nazwie ostatniego segmentu. Lista repo złapie
   * klon sama (ADR-18), więc daemon niczego nie zapisuje.
   */
  async clone(host: RepoHost, fullName: string): Promise<CloneJob> {
    if (!this.deps.file.repoHosts().some((h) => sameHost(h, host)))
      throw new DomainError("bad_request", `hostingu ${host.kind} ${host.host} nie ma w ustawieniach`);
    const projectsDir = this.deps.file.projectsDir();
    if (projectsDir === null) throw new DomainError("bad_request", "najpierw ustaw folder z projektami");
    const dir = cloneDir(fullName);
    const taken = await takenNames(projectsDir);
    // Od tego miejsca bez `await`, żeby dwa równoczesne żądania nie przeszły obu sprawdzeń.
    const path = join(projectsDir, dir);
    const running = this.clones.runningInto(path);
    if (running && sameHost(running.host, host) && running.fullName === fullName) return running;
    if (running) throw new DomainError("bad_request", `do ${path} trwa już klonowanie ${running.fullName}`);
    if (taken(dir)) throw new DomainError("bad_request", `w folderze z projektami jest już ${dir}`);
    return this.clones.start({ host, fullName, path }, () => this.deps.hosting.clone(host, fullName, path));
  }

  /** Klonowania do bieżącego folderu z projektami; te do folderu sprzed zmiany ustawień nie mówią nic o nim. */
  cloneJobs(): CloneJob[] {
    const projectsDir = this.deps.file.projectsDir();
    if (projectsDir === null) return [];
    return this.clones.list().filter((job) => dirKey(dirname(job.path)) === dirKey(projectsDir));
  }

  /**
   * Zaczyna synchronizację repo z folderu z projektami w tle; trwająca synchronizacja tego folderu zwraca się bez
   * startu nowej. Repo, do którego trwa klonowanie, jest pomijane: jego katalog nie jest jeszcze gotowym repo.
   */
  async sync(): Promise<SyncRun> {
    const { projectsDir, entries } = await this.entries();
    if (projectsDir === null) throw new DomainError("bad_request", "najpierw ustaw folder z projektami");
    const targets = entries.filter((entry) => !this.clones.runningInto(entry.path));
    return this.syncs.startOrJoin(dirKey(projectsDir), targets, SYNC_CONCURRENCY, (entry) => this.deps.vcs.sync(entry.path));
  }

  /** Ostatnia synchronizacja bieżącego folderu z projektami; ta sprzed zmiany ustawień nie mówi nic o nim. */
  syncRun(): SyncRun | null {
    const projectsDir = this.deps.file.projectsDir();
    return projectsDir === null ? null : (this.syncs.last(dirKey(projectsDir)) ?? null);
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
    const [status, remote] = await Promise.all([
      this.deps.vcs.status(entry.path).catch((err: unknown): RepoStatus => ({ kind: "unavailable", message: messageOf(err) })),
      // Brak adresu nie jest błędem repo: stan repo i tak powie, gdy git go nie czyta.
      this.deps.vcs.remote(entry.path).catch(() => null),
    ]);
    return { ...entry, remote, status };
  }

  private async hostRepos(host: RepoHost, query: string, taken: (name: string) => boolean): Promise<HostRepos> {
    try {
      const { repos, truncated } = await this.deps.hosting.repos(host, query);
      const withDirs = repos.map((repo) => {
        const dir = cloneDir(repo.fullName);
        return { ...repo, dir, inProjectsDir: taken(dir) };
      });
      return { host, listing: { kind: "ok", repos: withDirs, truncated } };
    } catch (err) {
      return { host, listing: { kind: "unavailable", message: messageOf(err) } };
    }
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

/** Katalog klonu: ostatni segment pełnej nazwy, jak przy `git clone` bez podanego katalogu. */
function cloneDir(fullName: string): string {
  const dir = fullName.split("/").at(-1);
  if (!dir) throw new Error(`pełna nazwa repo bez nazwy: "${fullName}"`);
  return dir;
}
