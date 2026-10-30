import { z } from "zod";
import { apiEndpoints, Done } from "./api.ts";
import { WorkingTreeChanges } from "./changes.ts";
import { CloneJob, CloneRequest, HostRepos, RepoHosts } from "./repo-hosts.ts";
import { SyncRun } from "./sync.ts";

/**
 * Contract of the `workspace` module (§4.5, §6): the repos of the projects folder and browsing their content from the last
 * commit. Every action is `POST /api/workspace/<action>`; `workspaceApi` keeps the path, the body schema and the result
 * schema together, so the daemon and the UI cannot pair them differently.
 */

/** A repo's slug from its directory name in the projects folder, lowercase. */
export const RepoId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "repo id: lowercase letters, digits, '.', '_' and '-'");
export type RepoId = z.infer<typeof RepoId>;

/**
 * A path in the commit's tree, with `/` as in git, without `.` and `..`; empty means the root. It does not touch the file
 * system (ADR-14), so `\` is an ordinary name character. Without control characters, because the daemon passes it to git line by line.
 */
export const RepoPath = z
  .string()
  .max(4096)
  .refine((p) => p === "" || p.split("/").every((s) => s !== "" && s !== "." && s !== ".."), "repo path: no empty, '.' or '..' segments")
  .refine((p) => [...p].every((c) => c >= " "), "repo path: no control characters");
export type RepoPath = z.infer<typeof RepoPath>;

/** A full commit hash, SHA-1 or SHA-256; the only kind the daemon passes to git as a revision and writes into file names. */
export const CommitHash = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "full commit hash");

export const Commit = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  /** ISO 8601, author time. */
  date: z.string(),
});
export type Commit = z.infer<typeof Commit>;

/** The repo status git returned. */
export const RepoStatusOk = z.object({
  kind: z.literal("ok"),
  /** `null` on a detached HEAD. */
  branch: z.string().nullable(),
  /** `null` in a repo without commits. */
  head: Commit.nullable(),
  /** The number of changed and untracked files in the working directory. */
  changes: z.number().int().nonnegative(),
  /** The untracked ones out of `changes`: new files git does not know yet. */
  untracked: z.number().int().nonnegative(),
  /** The tracking branch with counters; `null` when the branch has none or it disappeared on the remote. */
  upstream: z.object({ name: z.string(), ahead: z.number().int(), behind: z.number().int() }).nullable(),
});
export type RepoStatusOk = z.infer<typeof RepoStatusOk>;

/** Changed tracked files: `changes` without the new ones; one place for this rule for the repo status and the sync result. */
export function trackedChanges(status: Pick<RepoStatusOk, "changes" | "untracked">): number {
  return status.changes - status.untracked;
}

/**
 * The repo status observed in git on every request; it is never saved. `loading` is a repo of the quick list (`entries`,
 * ADR-113) whose status is still on its way; `list` and `repos` never return it.
 */
export const RepoStatus = z.discriminatedUnion("kind", [
  RepoStatusOk,
  /** The directory has `.git`, but git cannot read it (a damaged repo, no permissions, no `git` in `PATH`). */
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
  z.object({ kind: z.literal("loading") }),
]);
export type RepoStatus = z.infer<typeof RepoStatus>;

export const Repo = z.object({
  id: RepoId,
  path: z.string(),
  /**
   * The remote address without scheme, user, port and `.git`, for example `gitlab.example.com/group/project`
   * (ADR-21): the same repo under another directory name, or cloned over SSH and HTTPS, has the same address. From `origin`,
   * and without it from the only remote; `null` when there is no remote, there are several without `origin`, or it is a local path.
   */
  remote: z.string().nullable(),
  status: RepoStatus,
});
export type Repo = z.infer<typeof Repo>;

/**
 * The full path of the projects folder (ADR-18); `null` until the user sets it (in settings or in `workspace.yaml`), and
 * then the repo list is empty.
 */
const ProjectsDir = z.string().nullable();

export const RepoList = z.object({
  projectsDir: ProjectsDir,
  /** Sorted by directory name. */
  repos: z.array(Repo),
});
export type RepoList = z.infer<typeof RepoList>;

/** How many repos one `repos` request may ask for: a few screens of the list, so one answer does not wait for the whole folder. */
export const MAX_REPOS_PER_REQUEST = 50;

/**
 * The repo watch (ADR-63): the revision grows when the HEAD or refs of a repo in the projects folder change, or the set of
 * repos does. It carries no repo state, only "something changed since the last snapshot", so a client fetches the list and
 * the graph again. Revision 0 is the state at the watch's start (`startedAt`), and both start anew with every daemon, so a
 * client tells a restarted daemon by `startedAt`.
 */
export const RepoWatchState = z.object({ startedAt: z.iso.datetime(), revision: z.number().int().nonnegative() });
export type RepoWatchState = z.infer<typeof RepoWatchState>;

/**
 * A Copilot CLI tool permission pattern (ADR-66), `kind` or `kind(argument)` as `copilot help permissions` describes
 * it: `shell(git push)`, `shell(mvn:*)`, `write`, `trackwall(get_repo)`. It reaches Copilot CLI as one argument
 * (`--allow-tool=<pattern>`), so it is one line without control characters.
 */
export const ToolPermissionPattern = z
  .string()
  .min(1)
  .max(300)
  // `refine` instead of `regex`, so that `\p{Cc}` is read with the `u` flag (as in `visibleText`).
  .refine((p) => /^[A-Za-z0-9_.-]+(?:\([^\p{Cc}]*\))?$/u.test(p), {
    message: "a tool permission is `kind` or `kind(argument)` on one line, e.g. `shell(git push)`",
  });

/**
 * Tool permission rules from `workspace.yaml` (`toolPermissions`, ADR-66), by hand only: every rule whose `repos`
 * patterns match a session's repo identifier (`*` without `/`, ignoring case) adds its patterns to the session's
 * `--allow-tool` and `--deny-tool`; a rule without `repos` applies to every session, the supervisor included. Copilot
 * CLI applies them, and a denial wins over an approval.
 */
export const ToolPermissionRule = z
  .object({
    repos: z.array(z.string().min(1).max(300)).min(1).optional(),
    allow: z.array(ToolPermissionPattern).default([]),
    deny: z.array(ToolPermissionPattern).default([]),
  })
  .strict();
export const ToolPermissionRules = z.array(ToolPermissionRule);
export type ToolPermissionRules = z.infer<typeof ToolPermissionRules>;

/**
 * The patterns one session starts with, from the rules that apply to it (`--allow-tool` and `--deny-tool`). Here because
 * `workspace` computes it and `agents` uses it, and daemon modules share types only through `protocol`.
 */
export interface ToolPermissions {
  allow: readonly string[];
  deny: readonly string[];
}

/**
 * `supervisor` in `workspace.yaml` (ADR-78), by hand only. Without `changesCode: true` the supervisor starts with Copilot
 * CLI's `shell` and `write` tools denied, so it coordinates through Trackwall's tools and reads files, but changes nothing
 * itself; `true` gives it the tools and the `toolPermissions` rules without `repos`, like before ADR-78.
 */
export const SupervisorSettings = z.object({ changesCode: z.boolean().default(false) }).strict();
export type SupervisorSettings = z.infer<typeof SupervisorSettings>;

/** An environment variable name Copilot CLI's comma-separated `--secret-env-vars` can carry (ADR-93). */
export const ENV_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `agentSecrets` in `workspace.yaml` (ADR-93), by hand only: the secrets from mise that the tools of every session get
 * (its shell commands and the MCP servers Copilot CLI starts), e.g. the token of an issue tracker's MCP server. Every
 * other secret mise sets is hidden from them (`--secret-env-vars`), and mise tasks Trackwall runs get them all.
 */
export const AgentSecrets = z.array(z.string().regex(ENV_VARIABLE_NAME, "an environment variable name, e.g. JIRA_TOKEN")).max(200);
export type AgentSecrets = z.infer<typeof AgentSecrets>;

/**
 * `javaNavigation` in `workspace.yaml` (ADR-99), by hand only: the Java language server a task's Copilot CLI session can
 * get for code navigation (the `lsp` tool): `jdtls`, the folder of an unpacked Eclipse JDT Language Server; `java`, the
 * Java program that runs it (the version jdtls needs, not the project's); `lombok`, the `lombok.jar` jdtls loads as an
 * agent for a project that uses Lombok. All full paths, which the daemon checks.
 */
export const JavaNavigationSettings = z
  .object({
    jdtls: z.string().min(1),
    java: z.string().min(1),
    lombok: z
      .string()
      .min(1)
      .nullish()
      .transform((path) => path ?? null),
  })
  .strict();
export type JavaNavigationSettings = z.infer<typeof JavaNavigationSettings>;

/**
 * The name of a mise environment (`MISE_ENV`) that only sessions start with (ADR-136), e.g. `byok` for
 * `mise.byok.toml` with another model provider for Copilot CLI. A plain name, so it can only choose config files that
 * mise looks for anyway, never a path or a list.
 */
export const SessionProfile = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "a session profile is a name of up to 32 letters, digits, - and _, such as byok");
export type SessionProfile = z.infer<typeof SessionProfile>;

export const WorkspaceSettings = z.object({
  projectsDir: ProjectsDir,
  /** `worktreesDir` from `workspace.yaml` (ADR-84): where new task worktrees go; `null` for the default. */
  worktreesDir: z.string().nullable(),
  /** Why `worktreesDir` in `workspace.yaml` cannot be read (`worktreesDir` is then `null`); saving a folder or the default fixes it. */
  worktreesDirProblem: z.string().nullable(),
  /** The default task worktrees folder, `.trackwall/worktrees` in the projects folder; `null` while that is not set. */
  defaultWorktreesDir: z.string().nullable(),
  /** `gitProgram` from `workspace.yaml` (ADR-112): the git the daemon starts for local git calls; `null` for git from `PATH`. */
  gitProgram: z.string().nullable(),
  /** Why `gitProgram` in `workspace.yaml` cannot be read (`gitProgram` is then `null`); saving a program or the default fixes it. */
  gitProgramProblem: z.string().nullable(),
  /** `sessionProfile` from `workspace.yaml` (ADR-136): the mise environment sessions start with; `null` for none. */
  sessionProfile: z.string().nullable(),
  /** Why `sessionProfile` in `workspace.yaml` cannot be read; sessions do not start until it is fixed or saved again. */
  sessionProfileProblem: z.string().nullable(),
  /** The full path of `workspace.yaml`, so that the user knows which file to edit by hand. */
  configFile: z.string(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const TreeEntry = z.object({
  name: z.string(),
  /** The path from the repo root, as git returned it; passed back in `tree` and `file`. */
  path: z.string(),
  kind: z.enum(["dir", "file", "submodule"]),
  /** Size in bytes, only for files. */
  size: z.number().int().nonnegative().optional(),
});
export type TreeEntry = z.infer<typeof TreeEntry>;

export const FileContent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), size: z.number().int(), truncated: z.boolean() }),
  z.object({ kind: z.literal("binary"), size: z.number().int() }),
]);
export type FileContent = z.infer<typeof FileContent>;

/**
 * An address from a README that the UI may open in the system browser (ADR-35): only a web page, never `file:`, `mailto:`
 * or an app's own protocol. `normalize` gives the canonical form with percent-encoding, so no space, quote, `\` or control
 * character from the repo's content reaches the system.
 */
export const ExternalLink = z.url({ protocol: /^https?$/, normalize: true }).max(2048);

/**
 * An address the page itself opens in a new tab when the daemon has no desktop (ADR-120): only `http` or `https`, since a
 * `javascript:` address would run with the page's origin and read its token. No length limit beyond the browser's, as a
 * merge request form carries its description in the address.
 */
export const WebAddress = z.url({ protocol: /^https?$/ });

export const RepoOverview = z.object({
  /** `format` says whether the README is Markdown (ADR-35); `.txt`, `.rst` and `.adoc` are text. */
  readme: z.object({ path: z.string(), text: z.string(), truncated: z.boolean(), format: z.enum(["markdown", "text"]) }).nullable(),
  /** The latest commits, newest first; empty in a repo without commits. */
  commits: z.array(Commit),
});
export type RepoOverview = z.infer<typeof RepoOverview>;

export const RemoteRepoList = z.object({
  projectsDir: ProjectsDir,
  /** One entry per repo host from the settings, in their order. */
  hosts: z.array(HostRepos),
});
export type RemoteRepoList = z.infer<typeof RemoteRepoList>;

/**
 * What a folder dropped on the window means for the repo list (ADR-51): a listed repo (or a folder inside one), the
 * projects folder itself, a git repo somewhere else, a folder with repos directly inside it, which can become the
 * projects folder, a repo whose name starts with a dot, a folder without any repos, or a file. Repo counts use the
 * same rule as the list (ADR-18): direct subfolders with `.git`, without those starting with a dot.
 */
export const DroppedFolder = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("listed-repo"), repo: RepoId }),
  z.object({ kind: z.literal("projects-dir") }),
  /** `parent` is the folder that holds the repo; `parentRepos` counts the repos in it. */
  z.object({ kind: z.literal("repo-elsewhere"), path: z.string(), parent: z.string(), parentRepos: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("folder-with-repos"), path: z.string(), repos: z.number().int().positive() }),
  /** A git repo whose name starts with a dot, which the list skips wherever it is (ADR-18). */
  z.object({ kind: z.literal("hidden-repo"), path: z.string() }),
  z.object({ kind: z.literal("no-repos"), path: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);
export type DroppedFolder = z.infer<typeof DroppedFolder>;

const endpoint = apiEndpoints("workspace");

const RepoRequest = z.object({ repo: RepoId }).strict();

export const workspaceApi = {
  list: endpoint("list", z.object({}).strict(), RepoList),
  /**
   * The repos of the projects folder without asking git (ADR-113): every status is `loading` and every remote `null`, so a view
   * shows the list at once and fills it with `repos`.
   */
  entries: endpoint("entries", z.object({}).strict(), RepoList),
  /** The repos named, with status and remote, in the order asked; a repo no longer in the folder is left out (ADR-113). */
  repos: endpoint("repos", z.object({ repos: z.array(RepoId).min(1).max(MAX_REPOS_PER_REQUEST) }).strict(), z.array(Repo)),
  settings: endpoint("settings", z.object({}).strict(), WorkspaceSettings),
  /** `path` is the full path of an existing directory on the user's disk; saved in `workspace.yaml`. */
  setProjectsDir: endpoint("set-projects-dir", z.object({ path: z.string().min(1).max(4096) }).strict(), WorkspaceSettings),
  /** A folder in the home folder that looks like a projects folder (`Dev`, `Projects`…), offered while none is set; else `null`. */
  suggestedProjectsDir: endpoint("suggested-projects-dir", z.object({}).strict(), z.string().nullable()),
  /** `path` like `setProjectsDir`; `null` removes `worktreesDir` from `workspace.yaml`, so new tasks use the default folder. */
  setWorktreesDir: endpoint("set-worktrees-dir", z.object({ path: z.string().min(1).max(4096).nullable() }).strict(), WorkspaceSettings),
  /**
   * `path` is the full path of a git program (`git.exe` of MinGit or another Git for Windows) that answers `--version`;
   * `null` removes `gitProgram` from `workspace.yaml`, so the daemon uses git from `PATH` again (ADR-112).
   */
  setGitProgram: endpoint("set-git-program", z.object({ path: z.string().min(1).max(4096).nullable() }).strict(), WorkspaceSettings),
  /**
   * The mise environment new sessions start with (ADR-136); `null` removes `sessionProfile` from `workspace.yaml`. No MCP
   * tool sets it: an agent must not choose the model provider of sessions.
   */
  setSessionProfile: endpoint("set-session-profile", z.object({ profile: SessionProfile.nullable() }).strict(), WorkspaceSettings),
  overview: endpoint("overview", RepoRequest, RepoOverview),
  tree: endpoint("tree", z.object({ repo: RepoId, path: RepoPath }).strict(), z.array(TreeEntry)),
  file: endpoint(
    "file",
    z.object({ repo: RepoId, path: RepoPath.refine((p) => p !== "", "the file path cannot be empty") }).strict(),
    FileContent,
  ),
  /**
   * Working directory changes against HEAD (ADR-34): files and diff, with new files, without ignored ones. The user's
   * index stays untouched. In a repo without commits, against the empty tree.
   */
  changes: endpoint("changes", RepoRequest, WorkingTreeChanges),
  /** Opens an address from the README in the default browser (ADR-35), instead of in the app window. */
  openLink: endpoint("open-link", z.object({ url: ExternalLink }).strict(), Done),
  /** Opens `vscode://` in the system; the daemon does not know whether anything handled the address. */
  openEditor: endpoint("open-editor", RepoRequest, Done),
  /** Opens the repo folder in Explorer, Finder or the Linux file manager (ADR-51); like `openEditor`, without waiting for it. */
  openFolder: endpoint("open-folder", RepoRequest, Done),
  /** Says what a folder dropped on the window is (ADR-51); `path` is a full path on the user's disk, read and never saved. */
  droppedFolder: endpoint("dropped-folder", z.object({ path: z.string().min(1).max(4096) }).strict(), DroppedFolder),
  /**
   * Repo hosts from which repos can be cloned into the projects folder (ADR-19), in the order of `workspace.yaml`. Separate
   * from `settings`, because a bad entry in one key must not block fixing the other.
   */
  repoHosts: endpoint("repo-hosts", z.object({}).strict(), RepoHosts),
  /** Replaces the list of repo hosts in `workspace.yaml`. */
  setRepoHosts: endpoint("set-repo-hosts", z.object({ repoHosts: RepoHosts }).strict(), RepoHosts),
  /**
   * Repos available on each repo host, fetched through `gh` or `glab` and remembered for 60 s (§4.5); `query` searches the
   * name (GitLab on its side from 3 characters, also in the group path; shorter ones and GitHub are filtered by the daemon),
   * empty gives the most recently changed (GitLab) or all of them (GitHub).
   */
  remoteRepos: endpoint("remote-repos", z.object({ query: z.string().trim().max(100) }).strict(), RemoteRepoList),
  /** Starts cloning and returns it at once in the `running` state; progress through `clones`. */
  clone: endpoint("clone", CloneRequest, CloneJob),
  /** Clones into the current projects folder since the daemon started, in the order they began. */
  clones: endpoint("clones", z.object({}).strict(), z.array(CloneJob)),
  /**
   * Starts a sync of all repos in the projects folder (ADR-21) and returns it at once; a running one is returned without
   * starting a new one. Progress through `syncRun`.
   */
  sync: endpoint("sync", z.object({}).strict(), SyncRun),
  /** The last sync of the current projects folder since the daemon started; `null` when there was none. */
  syncRun: endpoint("sync-run", z.object({}).strict(), SyncRun.nullable()),
};
