import { dirname, join } from "node:path";
import {
  type AgentSecrets,
  type CloneJob,
  type Commit,
  type DayStartSettings,
  type DroppedFolder,
  type FileContent,
  type GraphConfig,
  type HostedRepo,
  type HostRepos,
  PATCH_MAX_BYTES,
  type RemoteRepoList,
  type Repo,
  type RepoHost,
  type RepoList,
  type RepoOverview,
  type RepoStatus,
  type RepoStatusOk,
  type RepoTagRules,
  type SearchCodeResult,
  type Session,
  type SupervisorSettings,
  type SyncResult,
  type SyncRun,
  sameHost,
  type ToolPermissions,
  type TreeEntry,
  type WorkingTreeChanges,
  type WorkspaceKeysRead,
  type WorkspaceSettings,
} from "@trackwall/protocol";
import { configOrProblem, DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { CloneJobs } from "./clone-jobs.ts";
import { type CodeSearchQuery, type CodeSearchVcs, searchCode } from "./code-search.ts";
import { describeDroppedFolder } from "./dropped-folder.ts";
import { isFullPath, NOT_FULL_PROGRAM_PATH } from "./full-path.ts";
import { dirKey, findRepos, projectsDirUnavailable, type RepoEntry, resolveFolderSetting, takenNames } from "./projects-dir.ts";
import { moveRepoOut } from "./repo-removal.ts";
import { suggestedProjectsDir } from "./suggested-projects-dir.ts";
import { SyncRuns } from "./sync-runs.ts";
import { sessionToolPermissions, supervisorToolPermissions } from "./tool-permissions.ts";
import type { WorkspaceFile } from "./workspace-file.ts";
import { checkWorktreesDir, defaultWorktreesDir } from "./worktrees-dir.ts";

/**
 * The `workspace` module (§4): repos from the projects folder set in `workspace.yaml` (ADR-18) and their state
 * as observed in git, plus cloning new repos from the repo hosts in the settings (ADR-19). Neither the list nor the state is
 * stored anywhere; every query reads the folder and asks git, so they do not drift from what the user does.
 * Sync of all repos (ADR-21) moves default branches to the remote ones. Clones and syncs live
 * only in memory, until the daemon restarts.
 */

/** How many commits the repo overview shows. */
const OVERVIEW_COMMITS = 30;
/** The limit for a file preview and README: nobody scrolls further in the panel anyway. */
const PREVIEW_MAX_BYTES = 512 * 1024;
const README = /^readme(\.(md|markdown|txt|rst|adoc))?$/i;
/** A README that is not Markdown; without an extension it is Markdown, as on GitHub (ADR-35). */
const PLAIN_TEXT_README = /\.(txt|rst|adoc)$/i;
/**
 * How many repos ask git at once for the list: the projects folder can have hundreds of them, and each is two `git` processes,
 * slow to start on Windows and scanned by the antivirus.
 */
const STATUS_CONCURRENCY = 8;
/**
 * How many repos sync at once: a fetch holds a connection to the repo host, and a self-hosted GitLab or a VPN can
 * limit the number of simultaneous SSH connections from one client.
 */
const SYNC_CONCURRENCY = 4;

/** What `workspace` needs from `vcs`; wired in the facade (§4: modules do not import each other). */
interface WorkspaceVcs extends CodeSearchVcs {
  checkGitProgram(path: string): Promise<void>;
  useGitProgram(path: string | null): void;
  status(dir: string): Promise<RepoStatusOk>;
  remote(dir: string): Promise<string | null>;
  sync(dir: string): Promise<SyncResult>;
  log(dir: string, limit: number): Promise<Commit[]>;
  tree(dir: string, path: string): Promise<TreeEntry[] | undefined>;
  file(dir: string, path: string, maxBytes: number): Promise<FileContent | undefined>;
  changes(dir: string, maxPatchBytes: number): Promise<WorkingTreeChanges>;
}

/** What `workspace` needs from the repo hosts of the `vcs` module (ADR-19). */
interface WorkspaceHosting {
  repos(host: RepoHost, query: string): Promise<{ repos: HostedRepo[]; truncated: boolean }>;
  clone(host: RepoHost, fullName: string, dest: string): Promise<void>;
}

export interface WorkspaceDeps {
  file: WorkspaceFile;
  vcs: WorkspaceVcs;
  hosting: WorkspaceHosting;
  /** Opens a directory in VS Code (`vscode://` in the system, built in the facade). */
  openEditor: (dir: string) => void;
  /** Opens a folder in Explorer, Finder or the Linux file manager (ADR-51). */
  openFolder: (dir: string) => void;
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
    const projectsDir = this.deps.file.projectsDir();
    // A bad `worktreesDir` typed by hand must not take away the projects folder form, and saving a folder fixes it.
    const worktreesDir = configOrProblem(() => this.deps.file.worktreesDir(), null);
    const gitProgram = configOrProblem(() => this.deps.file.gitProgram(), null);
    return {
      projectsDir,
      worktreesDir: worktreesDir.value,
      worktreesDirProblem: worktreesDir.problem,
      defaultWorktreesDir: projectsDir === null ? null : defaultWorktreesDir(projectsDir),
      gitProgram: gitProgram.value,
      gitProgramProblem: gitProgram.problem,
      configFile: this.configFile(),
    };
  }

  /** A projects folder to offer, only while none is set; a bad one in `workspace.yaml` is `invalid_config`, fixed with the form. */
  async suggestedProjectsDir(home: string): Promise<string | null> {
    if (this.deps.file.projectsDir() !== null) return null;
    return suggestedProjectsDir(home);
  }

  async setProjectsDir(path: string): Promise<WorkspaceSettings> {
    this.deps.file.setProjectsDir(await resolveFolderSetting(path));
    return this.settings();
  }

  /** `null` goes back to the default folder; tasks that already exist keep their worktrees where they are (ADR-84). */
  async setWorktreesDir(path: string | null): Promise<WorkspaceSettings> {
    this.deps.file.setWorktreesDir(path === null ? null : await this.checkedWorktreesDir(path));
    return this.settings();
  }

  /**
   * The git for local git calls (ADR-112), checked by running it first; `null` goes back to git from `PATH`. Takes effect at
   * once. A hand edit of `workspace.yaml` takes effect at the next daemon start (`useGitProgramFromFile`).
   */
  async setGitProgram(path: string | null): Promise<WorkspaceSettings> {
    if (path !== null) await this.checkedGitProgram(path);
    this.deps.file.setGitProgram(path);
    this.deps.vcs.useGitProgram(path);
    return this.settings();
  }

  /** Hands the saved "Git program" to `vcs` at the daemon start; a bad key means git from `PATH`, and Settings shows why. */
  useGitProgramFromFile(): void {
    this.deps.vcs.useGitProgram(configOrProblem(() => this.deps.file.gitProgram(), null).value);
  }

  private async checkedGitProgram(path: string): Promise<void> {
    if (!isFullPath(path)) throw new DomainError("bad_request", `${path}: ${NOT_FULL_PROGRAM_PATH}`);
    await this.deps.vcs.checkGitProgram(path).catch((err: unknown) => {
      throw new DomainError("bad_request", `${path} cannot be used as the git program: ${messageOf(err)}`);
    });
  }

  private async checkedWorktreesDir(path: string): Promise<string> {
    const dir = await resolveFolderSetting(path);
    await checkWorktreesDir(dir, this.deps.file.projectsDir());
    return dir;
  }

  /**
   * What a folder dropped on the window is (ADR-51). A bad `projectsDir` or a missing projects folder does not get in
   * the way: dropping a folder is one of the ways to fix them.
   */
  async droppedFolder(path: string): Promise<DroppedFolder> {
    const projectsDir = configOrProblem(() => this.deps.file.projectsDir(), null).value;
    return describeDroppedFolder(path, projectsDir);
  }

  repoHosts(): RepoHost[] {
    return this.deps.file.repoHosts();
  }

  setRepoHosts(hosts: RepoHost[]): RepoHost[] {
    this.deps.file.setRepoHosts(hosts);
    return this.repoHosts();
  }

  /**
   * Repos matching `query` from every repo host at once; a repo host that does not answer does not take away the others' lists.
   */
  async remoteRepos(query: string): Promise<RemoteRepoList> {
    const projectsDir = this.deps.file.projectsDir();
    const taken = projectsDir === null ? () => false : await takenNames(projectsDir);
    const hosts = await Promise.all(this.deps.file.repoHosts().map((host) => this.hostRepos(host, query, taken)));
    return { projectsDir, hosts };
  }

  /**
   * Starts a clone of `fullName` into the projects folder, into a directory named after the last segment. The repo list picks up
   * the clone by itself (ADR-18), so the daemon stores nothing.
   */
  async clone(host: RepoHost, fullName: string): Promise<CloneJob> {
    if (!this.deps.file.repoHosts().some((h) => sameHost(h, host)))
      throw new DomainError("bad_request", `host ${host.kind} ${host.host} is not in the settings`);
    const projectsDir = this.deps.file.projectsDir();
    if (projectsDir === null) throw new DomainError("bad_request", "set the projects folder first");
    const dir = cloneDir(fullName);
    const taken = await takenNames(projectsDir);
    // From here on without `await`, so that two simultaneous requests do not both pass the checks.
    const path = join(projectsDir, dir);
    const running = this.clones.runningInto(path);
    if (running && sameHost(running.host, host) && running.fullName === fullName) return running;
    if (running) throw new DomainError("bad_request", `${running.fullName} is already being cloned into ${path}`);
    if (taken(dir)) throw new DomainError("bad_request", `the projects folder already has ${dir}`);
    return this.clones.start({ host, fullName, path }, () => this.deps.hosting.clone(host, fullName, path));
  }

  /** Clones into the current projects folder; those into the folder from before a settings change say nothing about it. */
  cloneJobs(): CloneJob[] {
    const projectsDir = this.deps.file.projectsDir();
    if (projectsDir === null) return [];
    return this.clones.list().filter((job) => dirKey(dirname(job.path)) === dirKey(projectsDir));
  }

  /**
   * Starts a sync of the repos from the projects folder in the background; a running sync of this folder is returned without
   * starting a new one. A repo that is being cloned is skipped: its directory is not a ready repo yet.
   */
  async sync(): Promise<SyncRun> {
    const { key, targets } = await this.syncTargets();
    return this.syncs.startOrJoin(key, targets, SYNC_CONCURRENCY, (entry) => this.deps.vcs.sync(entry.path));
  }

  /** The same sync as `sync`, resolved once every repo has its result (the day start, ADR-70). */
  async syncAndWait(): Promise<SyncRun> {
    const { key, targets } = await this.syncTargets();
    return this.syncs.startOrJoinAndWait(key, targets, SYNC_CONCURRENCY, (entry) => this.deps.vcs.sync(entry.path));
  }

  /** The sync key of the projects folder and its repos, without a repo that is being cloned. */
  private async syncTargets(): Promise<{ key: string; targets: RepoEntry[] }> {
    const { projectsDir, entries } = await this.entries();
    if (projectsDir === null) throw new DomainError("bad_request", "set the projects folder first");
    return { key: dirKey(projectsDir), targets: entries.filter((entry) => !this.clones.runningInto(entry.path)) };
  }

  /**
   * Sync of one repo for the batch command (§4.8); a repo that is being cloned is an error. A running
   * sync of the whole folder does not get in the way, because `vcs` syncs one `.git` directory at a time.
   */
  async syncRepo(id: string): Promise<SyncResult> {
    const entry = await this.entry(id);
    if (this.clones.runningInto(entry.path)) throw new DomainError("bad_request", `${id}: this repo is being cloned`);
    return this.deps.vcs.sync(entry.path);
  }

  /** The last sync of the current projects folder; one from before a settings change says nothing about it. */
  syncRun(): SyncRun | null {
    const projectsDir = this.deps.file.projectsDir();
    return projectsDir === null ? null : (this.syncs.last(dirKey(projectsDir)) ?? null);
  }

  /** One repo from the list with its state and remote repo address, without asking git about the other repos in the folder. */
  async repo(id: string): Promise<Repo> {
    return this.describe(await this.entry(id));
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
    if (!entries) throw new DomainError("not_found", `${id} has no directory "${path}" in the latest commit`);
    return entries;
  }

  async file(id: string, path: string): Promise<FileContent> {
    const entry = await this.entry(id);
    const content = await this.inRepo(entry, () => this.deps.vcs.file(entry.path, path, PREVIEW_MAX_BYTES));
    if (!content) throw new DomainError("not_found", `${id} has no file "${path}" in the latest commit`);
    return content;
  }

  /** Changes of the repo's working directory against HEAD (ADR-34). */
  async changes(id: string): Promise<WorkingTreeChanges> {
    const entry = await this.entry(id);
    return this.inRepo(entry, () => this.deps.vcs.changes(entry.path, PATCH_MAX_BYTES));
  }

  /**
   * Code search in the HEAD commit of the listed repos (ADR-40), all of them or those in `ids`; an unknown id is
   * `not_found`, so that a typo does not look like "nothing found".
   */
  async searchCode(query: CodeSearchQuery, ids?: readonly string[]): Promise<SearchCodeResult> {
    const { entries } = await this.entries();
    const unknown = ids?.find((id) => !entries.some((e) => e.id === id));
    if (unknown !== undefined) throw unknownRepo(unknown);
    return searchCode(ids ? entries.filter((e) => ids.includes(e.id)) : entries, this.deps.vcs, query);
  }

  /** The daemon does not know whether the system handled the address; the result only confirms it was accepted. */
  async openEditor(id: string): Promise<void> {
    this.deps.openEditor((await this.entry(id)).path);
  }

  /** Only a listed repo's folder is opened, never a path from the request (ADR-51). */
  async openFolder(id: string): Promise<void> {
    this.deps.openFolder((await this.entry(id)).path);
  }

  /** The repo root by identifier, for modules that run processes in it (`mise`). */
  async repoPath(id: string): Promise<string> {
    return (await this.entry(id)).path;
  }

  /**
   * Moves the repo into the removed repos folder of the projects folder (ADR-83) and returns its new path. Refused when
   * the identifier now names another folder (the projects folder changed since the proposal) or a clone writes into it.
   */
  async removeRepo(id: string, expectedDir: string, beforeMove: () => void): Promise<string> {
    const entry = await this.entry(id);
    if (entry.path !== expectedDir)
      throw new DomainError("bad_request", `${id} is no longer ${expectedDir}; reject this proposal and propose the removal again`);
    const projectsDir = await this.projectsDir();
    return moveRepoOut(projectsDir, entry.path, () => {
      if (this.clones.runningInto(entry.path))
        throw new DomainError("bad_request", `${id} is still being cloned; wait for the clone to end`);
      beforeMove();
    });
  }

  /** The projects folder itself, where the supervisor runs (ADR-58); `bad_request` while it is not set. */
  async projectsDir(): Promise<string> {
    const projectsDir = this.deps.file.projectsDir();
    if (projectsDir === null) throw new DomainError("bad_request", "set the projects folder first");
    return projectsDir;
  }

  /**
   * The folder for a new task's worktree (ADR-84): `worktreesDir` or `.trackwall-worktrees` in the projects folder,
   * checked again here, because the projects folder may have changed since the setting was saved.
   */
  async worktreesDir(): Promise<string> {
    const projectsDir = await this.projectsDir();
    const dir = this.deps.file.worktreesDir() ?? defaultWorktreesDir(projectsDir);
    await checkWorktreesDir(dir, projectsDir);
    return dir;
  }

  /** Repos from the projects folder (identifier and root), for modules that read every repo (`cards`). */
  async repoEntries(): Promise<RepoEntry[]> {
    return (await this.entries()).entries;
  }

  /** Repo tag rules from `workspace.yaml` (ADR-25). */
  tagRules(): RepoTagRules {
    return this.deps.file.repoTagRules();
  }

  /**
   * The tool permissions of a Copilot CLI session in repo `repo` (`null` in the projects folder), or of the supervisor,
   * from `workspace.yaml` (ADR-66); `invalid_config` for a bad `toolPermissions`, so that no session starts without a
   * denial the user wrote. A free session (ADR-100) gets the rules without `repos`, without the supervisor's denial.
   */
  toolPermissions(session: Pick<Session, "repo" | "supervisor">): ToolPermissions {
    const rules = this.deps.file.toolPermissionRules();
    return session.supervisor ? supervisorToolPermissions(rules, this.supervisorSettings()) : sessionToolPermissions(rules, session.repo);
  }

  /**
   * The supervisor settings (`supervisor` in `workspace.yaml`, ADR-78); `invalid_config` for a bad key, so that a typo
   * never lifts the supervisor's denial.
   */
  supervisorSettings(): SupervisorSettings {
    return this.deps.file.supervisorSettings();
  }

  /**
   * The secrets from mise that the tools of sessions get (`agentSecrets` in `workspace.yaml`, ADR-93); `invalid_config`
   * for a bad key, so that a typo never shows a secret to an agent.
   */
  agentSecrets(): AgentSecrets {
    return this.deps.file.agentSecrets();
  }

  /** The user's addition to the day start's first message (`dayStart` in `workspace.yaml`, ADR-70); `null` without one. */
  dayStartSettings(): DayStartSettings | null {
    return this.deps.file.dayStartSettings();
  }

  /** Package aliases and manual graph edges from `workspace.yaml` (ADR-29). */
  graphConfig(): GraphConfig {
    return this.deps.file.graphConfig();
  }

  /** The full path of `workspace.yaml`, e.g. as the evidence of a user entry in the graph. */
  configFile(): string {
    return this.deps.file.path;
  }

  /** Each key of `workspace.yaml` with its value and where it comes from (ADR-108); throws when the file cannot be read. */
  workspaceKeys(): WorkspaceKeysRead {
    return this.deps.file.keyStates();
  }

  /** Without a projects folder set there are no repos. */
  private async entries(): Promise<{ projectsDir: string | null; entries: RepoEntry[] }> {
    const projectsDir = this.deps.file.projectsDir();
    return { projectsDir, entries: projectsDir === null ? [] : await findRepos(projectsDir, projectsDirUnavailable) };
  }

  private async entry(id: string): Promise<RepoEntry> {
    const entry = (await this.entries()).entries.find((r) => r.id === id);
    if (!entry) throw unknownRepo(id);
    return entry;
  }

  private async describe(entry: RepoEntry): Promise<Repo> {
    const [status, remote] = await Promise.all([
      this.deps.vcs.status(entry.path).catch((err: unknown): RepoStatus => ({ kind: "unavailable", message: messageOf(err) })),
      // A missing address is not a repo error: the repo state will say anyway when git cannot read it.
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
    if (content?.kind !== "text") return null;
    const format = PLAIN_TEXT_README.test(best.name) ? "text" : "markdown";
    return { path: best.path, text: content.text, truncated: content.truncated, format };
  }

  /** A git error while reading a repo from the list is a repo state (`repo_unavailable`), not a daemon error. */
  private async inRepo<T>(entry: RepoEntry, readFromGit: () => Promise<T>): Promise<T> {
    try {
      return await readFromGit();
    } catch (err) {
      throw new DomainError("repo_unavailable", `${entry.id}: ${messageOf(err)}`);
    }
  }
}

function unknownRepo(id: string): DomainError {
  return new DomainError("not_found", `no repo "${id}" in the projects folder`);
}

/** The clone directory: the last segment of the full name, as with `git clone` without a directory. */
function cloneDir(fullName: string): string {
  const dir = fullName.split("/").at(-1);
  if (!dir) throw new Error(`full repo name has no final segment: "${fullName}"`);
  return dir;
}
