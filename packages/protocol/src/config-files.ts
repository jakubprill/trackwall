import { z } from "zod";
import { Done, type Endpoint } from "./api.ts";
import { countLabel } from "./plural.ts";

/**
 * Contract of the `config-files` module (ADR-108): every file and folder Trackwall reads or writes on this computer, where
 * it is, what it is for and its state, and each key of `workspace.yaml` with its value and where it comes from. It only
 * reads; Settings changes the files as before. Every action is `POST /api/config-files/<action>`.
 */

/** Where an entry lies: Trackwall's state folder, the projects folder, or Copilot CLI's own folder. */
export const ConfigPlace = z.enum(["state", "projects", "copilot"]);
export type ConfigPlace = z.infer<typeof ConfigPlace>;

/** One file or folder, in the order the view lists them. */
export const ConfigEntryId = z.enum([
  "workspace-file",
  "tasks-file",
  "resumable-sessions-file",
  "last-supervisor-file",
  "agent-queues-file",
  "verifications-file",
  "day-start-file",
  "cards-dir",
  "logs-dir",
  "local-config-push-repo",
  "legacy-worktrees-dir",
  "projects-mise-config",
  "local-config-store",
  "task-worktrees-dir",
  "removed-repos-dir",
  "scratch-dir",
  "language-server-dir",
  "copilot-config",
]);
export type ConfigEntryId = z.infer<typeof ConfigEntryId>;

/** Who changes the entry: the user (by hand or through Settings), Trackwall itself, or Copilot CLI. */
export type ConfigWriter = "you" | "trackwall" | "copilot-cli";

/** A page of the documentation site, as its path under `features/` (`apps/docs/features/<page>.md`). */
export type DocsPage =
  | "approvals"
  | "config-files"
  | "doctor"
  | "graph"
  | "java-navigation"
  | "local-config"
  | "mise-environment"
  | "repo-card"
  | "repos"
  | "sessions"
  | "start-my-day"
  | "supervisor"
  | "tasks"
  | "trackwall-errors";

export interface ConfigEntryInfo {
  place: ConfigPlace;
  kind: "file" | "folder";
  writer: ConfigWriter;
  /** Trackwall's own memory, which the user does not edit: the view folds these into one line. */
  internal: boolean;
  /** What it is for, in one sentence for the person using Trackwall. */
  purpose: string;
  docs: DocsPage;
}

/** The one place for what each entry is for; the view, its documentation page and the doctor say the same. */
export const CONFIG_ENTRIES: Record<ConfigEntryId, ConfigEntryInfo> = {
  "workspace-file": {
    place: "state",
    kind: "file",
    writer: "you",
    internal: false,
    purpose:
      "Your workspace settings. Settings changes three keys; the others you write by hand, and you can keep the file in a private repo.",
    docs: "config-files",
  },
  "tasks-file": {
    place: "state",
    kind: "file",
    writer: "trackwall",
    internal: true,
    purpose: "Your agent tasks, so they come back after a restart.",
    docs: "tasks",
  },
  "resumable-sessions-file": {
    place: "state",
    kind: "file",
    writer: "trackwall",
    internal: true,
    purpose: "The sessions that resume when Trackwall starts again.",
    docs: "sessions",
  },
  "last-supervisor-file": {
    place: "state",
    kind: "file",
    writer: "trackwall",
    internal: true,
    purpose: "The supervisor conversation that Start resumes.",
    docs: "supervisor",
  },
  "agent-queues-file": {
    place: "state",
    kind: "file",
    writer: "trackwall",
    internal: true,
    purpose: "Task proposals, reviews, messages, updates and mise trust notices that still wait, so they come back after a restart.",
    docs: "sessions",
  },
  "verifications-file": {
    place: "state",
    kind: "file",
    writer: "trackwall",
    internal: true,
    purpose: "The last verification of each task, so its verdict is still there after a restart.",
    docs: "tasks",
  },
  "day-start-file": {
    place: "state",
    kind: "file",
    writer: "trackwall",
    internal: true,
    purpose: "When you last ran Start my day.",
    docs: "start-my-day",
  },
  "cards-dir": {
    place: "state",
    kind: "folder",
    writer: "trackwall",
    internal: true,
    purpose: "Repo cards read from each commit, so a commit is read only once.",
    docs: "repo-card",
  },
  "logs-dir": {
    place: "state",
    kind: "folder",
    writer: "trackwall",
    internal: true,
    purpose: "The output of mise tasks and Trackwall's own errors.",
    docs: "trackwall-errors",
  },
  "local-config-push-repo": {
    place: "state",
    kind: "folder",
    writer: "trackwall",
    internal: true,
    purpose: "The repo the local config store is pushed from, so only Trackwall chooses where the backups go.",
    docs: "local-config",
  },
  "legacy-worktrees-dir": {
    place: "state",
    kind: "folder",
    writer: "trackwall",
    internal: true,
    purpose: "Task worktrees from before version 0.5.1. New tasks no longer go here.",
    docs: "tasks",
  },
  "projects-mise-config": {
    place: "projects",
    kind: "file",
    writer: "you",
    internal: false,
    purpose: "The variables and secrets every session gets, read by mise.",
    docs: "mise-environment",
  },
  "local-config-store": {
    place: "projects",
    kind: "folder",
    writer: "trackwall",
    internal: false,
    purpose: "The backup of each repo's local config, as a git repo you can push to a remote of your own.",
    docs: "local-config",
  },
  "task-worktrees-dir": {
    place: "projects",
    kind: "folder",
    writer: "trackwall",
    internal: false,
    purpose: "Agent tasks' own copies of repos, one per task, removed when you end the task.",
    docs: "tasks",
  },
  "removed-repos-dir": {
    place: "projects",
    kind: "folder",
    writer: "trackwall",
    internal: false,
    purpose: "Repos the supervisor removed at your request. Nothing is deleted; move a repo back to restore it.",
    docs: "supervisor",
  },
  "scratch-dir": {
    place: "projects",
    kind: "folder",
    writer: "trackwall",
    internal: true,
    purpose: "Git's scratch files while Trackwall reads changes or backs up local config; empty between git commands.",
    docs: "config-files",
  },
  "language-server-dir": {
    place: "projects",
    kind: "folder",
    writer: "trackwall",
    internal: false,
    purpose: "The Java language server's index of each task with Java navigation, removed when you end the task.",
    docs: "java-navigation",
  },
  "copilot-config": {
    place: "copilot",
    kind: "file",
    writer: "copilot-cli",
    internal: false,
    purpose: "The folders Copilot CLI trusts without asking. Trackwall only reads it.",
    docs: "doctor",
  },
};

/** `invalid`: the entry is there but cannot be read as Trackwall expects; `detail` says why. */
export const ConfigEntryState = z.enum(["present", "missing", "invalid"]);
export type ConfigEntryState = z.infer<typeof ConfigEntryState>;

export const ConfigEntry = z.object({
  id: ConfigEntryId,
  /** The file or folder name, also while the projects folder is not set: `workspace.yaml`, `.trackwall/local`. */
  name: z.string(),
  /** The full path; `null` when it depends on the projects folder, which is not set. */
  path: z.string().nullable(),
  state: ConfigEntryState,
  /** What is in it, or why it cannot be read, in one line: `4 tasks`, `trusts C:\Users\me\Dev`. */
  detail: z.string().nullable(),
});
export type ConfigEntry = z.infer<typeof ConfigEntry>;

/** The keys of `workspace.yaml`, in the order of the view. */
export const WorkspaceKey = z.enum([
  "projectsDir",
  "worktreesDir",
  "gitProgram",
  "repoHosts",
  "toolPermissions",
  "agentSecrets",
  "javaNavigation",
  "localConfigRemote",
  "supervisor",
  "repoTags",
  "dayStart",
  "graph",
]);
export type WorkspaceKey = z.infer<typeof WorkspaceKey>;

export interface WorkspaceKeyInfo {
  purpose: string;
  docs: DocsPage;
  /** The Settings category that changes the key; `null` for a key only written by hand. */
  settings: "workspace" | "repo-hosts" | "agents" | null;
}

export const WORKSPACE_KEYS: Record<WorkspaceKey, WorkspaceKeyInfo> = {
  projectsDir: { purpose: "The folder with all your repos.", docs: "repos", settings: "workspace" },
  worktreesDir: { purpose: "Where agent tasks get their own copy of a repo.", docs: "tasks", settings: "workspace" },
  gitProgram: { purpose: "Which git Trackwall runs to read your repos.", docs: "repos", settings: "workspace" },
  repoHosts: { purpose: "Where the Repos view searches and clones from.", docs: "repos", settings: "repo-hosts" },
  toolPermissions: { purpose: "Which tools sessions may use without asking you.", docs: "approvals", settings: null },
  agentSecrets: { purpose: "The secrets from mise that the tools of sessions may read.", docs: "mise-environment", settings: null },
  javaNavigation: { purpose: "The Java language server tasks can get for code navigation.", docs: "java-navigation", settings: "agents" },
  localConfigRemote: { purpose: "The only remote the local config store is pushed to.", docs: "local-config", settings: "workspace" },
  supervisor: { purpose: "Whether the supervisor may change code itself.", docs: "supervisor", settings: null },
  repoTags: { purpose: "Your own tags on repo cards, by repo name or address.", docs: "repo-card", settings: null },
  dayStart: { purpose: "Your addition to the first message of Start my day.", docs: "start-my-day", settings: null },
  graph: { purpose: "Package aliases and links the graph cannot find by itself.", docs: "graph", settings: null },
};

export const WorkspaceKeyState = z.object({
  key: WorkspaceKey,
  /** `file` when `workspace.yaml` has the key, `default` when Trackwall uses its default. */
  from: z.enum(["file", "default"]),
  /** The value in one line (`3 rules`, a path); `null` when the key cannot be read. */
  value: z.string().nullable(),
  /** The key's line in the file, from 1; `null` for a default. */
  line: z.number().int().positive().nullable(),
  /** Why the key cannot be read; `null` when it can. */
  problem: z.string().nullable(),
});
export type WorkspaceKeyState = z.infer<typeof WorkspaceKeyState>;

/** A top-level key of `workspace.yaml` Trackwall does not read: a typo, or `repos` from version 0.2.0. */
export const UnknownWorkspaceKey = z.object({ name: z.string(), line: z.number().int().positive().nullable() });
export type UnknownWorkspaceKey = z.infer<typeof UnknownWorkspaceKey>;

/** Every key of `workspace.yaml` as read: Trackwall's keys in `WorkspaceKey` order, then the keys it does not read. */
export interface WorkspaceKeysRead {
  keys: WorkspaceKeyState[];
  unknown: UnknownWorkspaceKey[];
}

/**
 * `workspace.yaml` in one line, the same in Settings › Files and the doctor: `broken` when a key cannot be read, `unknown`
 * when a key is not Trackwall's (a typo leaves the setting at its default without a word), otherwise how many keys it sets.
 */
export function workspaceKeysSummary({ keys, unknown }: WorkspaceKeysRead): { state: "ok" | "unknown" | "broken"; text: string } {
  const at = (name: string, line: number | null) => (line === null ? name : `${name} (line ${line})`);
  const broken = keys.filter((k) => k.problem !== null);
  if (broken.length > 0)
    return {
      state: "broken",
      text: `${countLabel(broken.length, { one: "key cannot", other: "keys cannot" })} be read: ${broken.map((k) => at(k.key, k.line)).join(", ")}`,
    };
  if (unknown.length > 0)
    return {
      state: "unknown",
      text: `Trackwall does not read ${countLabel(unknown.length, { one: "key", other: "keys" })}: ${unknown.map((k) => at(k.name, k.line)).join(", ")}`,
    };
  return { state: "ok", text: `${keys.filter((k) => k.from === "file").length} of ${keys.length} keys set in the file` };
}

/** How the state folder was chosen: the daemon's `--home`, `TRACKWALL_HOME`, or the default `~/.trackwall`. */
export const StateDirSource = z.enum(["flag", "env", "default"]);
export type StateDirSource = z.infer<typeof StateDirSource>;

export const ConfigFilesReport = z.object({
  stateDir: z.object({ path: z.string(), from: StateDirSource }),
  /** The folder of each place; the projects folder is `null` while it is not set. */
  places: z.object({ state: z.string(), projects: z.string().nullable(), copilot: z.string() }),
  /** In `ConfigEntryId` order. */
  entries: z.array(ConfigEntry),
  /** In `WorkspaceKey` order; empty when `workspace.yaml` as a whole cannot be read (its entry says why). */
  workspaceKeys: z.array(WorkspaceKeyState),
  /** The top-level keys of `workspace.yaml` Trackwall does not read, in file order. */
  unknownWorkspaceKeys: z.array(UnknownWorkspaceKey),
});
export type ConfigFilesReport = z.infer<typeof ConfigFilesReport>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/config-files/${action}`, request, data };
}

const EntryRequest = z.object({ id: ConfigEntryId }).strict();

export const configFilesApi = {
  list: endpoint("list", z.object({}).strict(), ConfigFilesReport),
  /** Opens a file entry in the editor, as "Open in editor" opens a repo; a folder entry is refused. */
  openInEditor: endpoint("open-in-editor", EntryRequest, Done),
  /** Opens a folder entry, or the folder that holds a file entry, in Explorer, Finder or the file manager. */
  showInFolder: endpoint("show-in-folder", EntryRequest, Done),
};
