import { z } from "zod";
import { WORKTREE_INCLUDE_FILE } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import type { WorkspaceKey } from "./config-files.ts";
import type { TrackwallFolder } from "./trackwall-dir.ts";
import { Commit, CommitHash, RepoId } from "./workspace.ts";

/**
 * Contract of the `local-config` module (§4.13, ADR-86): the files a repo keeps outside git on purpose, backed up into
 * the workspace store, a git repo in the projects folder, and restored from it into a new clone. Every action is
 * `POST /api/local-config/<action>`.
 */

/**
 * mise's main config file in the repo root. Local config only in a repo whose commits do not have it, where the user keeps
 * it out of git because the team does not accept mise configuration (ADR-110).
 */
export const MISE_CONFIG_FILE = "mise.toml";

/** mise's config file for one clone, which git should not see: mise reads it on top of `mise.toml` (ADR-20). */
export const MISE_LOCAL_CONFIG_FILE = "mise.local.toml";

/**
 * The local config files, by name in the repo root; nothing else is backed up, so no `.env` with secrets by accident. A
 * file the repo's commits have is the repo's, not local config, so a tracked `mise.toml` is left alone.
 */
export const LOCAL_CONFIG_FILES = [MISE_CONFIG_FILE, MISE_LOCAL_CONFIG_FILE, WORKTREE_INCLUDE_FILE] as const;
export const LocalConfigFileName = z.enum(LOCAL_CONFIG_FILES);
export type LocalConfigFileName = z.infer<typeof LocalConfigFileName>;

/** A local config file is a few lines; a bigger one is not backed up, so a file rewritten in a loop cannot fill the store. */
export const MAX_LOCAL_CONFIG_BYTES = 256 * 1024;

/**
 * One local config file of a repo against the store. `ignored`: git ignores the file in the repo, so no commit takes it
 * along; a file that is not ignored can still end up in a merge request.
 */
export const LocalConfigFileState = z.discriminatedUnion("kind", [
  /** Neither in the repo nor in the store. */
  z.object({ kind: z.literal("absent"), file: LocalConfigFileName }),
  /** The repo's commits have the file: it is not local config, so the store leaves it alone. */
  z.object({ kind: z.literal("tracked"), file: LocalConfigFileName }),
  /** The store's last backup has the same content as the repo. */
  z.object({ kind: z.literal("backed_up"), file: LocalConfigFileName, ignored: z.boolean() }),
  /** The repo's file differs from the store's last backup, or the store has none yet: the next backup takes it, as the repo's file wins. */
  z.object({ kind: z.literal("pending"), file: LocalConfigFileName, ignored: z.boolean() }),
  /** Only the store has the file, for example after a new clone: it can be restored. */
  z.object({ kind: z.literal("missing"), file: LocalConfigFileName }),
]);
export type LocalConfigFileState = z.infer<typeof LocalConfigFileState>;

export const RepoLocalConfig = z.object({
  repo: RepoId,
  /** In the order of `LOCAL_CONFIG_FILES`. */
  files: z.array(LocalConfigFileState),
});
export type RepoLocalConfig = z.infer<typeof RepoLocalConfig>;

/** The last push of the store to its remote since the daemon started. */
export const WorkspaceStorePush = z.discriminatedUnion("kind", [
  /** No push yet: the store has no remote, or nothing was backed up since the daemon started. */
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("ok"), at: z.string() }),
  z.object({ kind: z.literal("failed"), at: z.string(), message: z.string() }),
]);
export type WorkspaceStorePush = z.infer<typeof WorkspaceStorePush>;

/**
 * The folders of `.trackwall` the workspace store also keeps while the user allows it (`storePlanAndKnowledge`, ADR-298),
 * each at the same name in the store: only the approved versions of knowledge entries and routines, the whole board and
 * the user's own task templates.
 */
export const WORKSPACE_STORE_FOLDERS = ["knowledge", "routines", "board", "task-templates"] as const satisfies readonly TrackwallFolder[];
export type WorkspaceStoreFolder = (typeof WORKSPACE_STORE_FOLDERS)[number];

/**
 * The folders of the workspace store with the user's own setup while the user allows it (`storeSettings`, ADR-299):
 * `trackwall/` keeps `workspace.yaml`, `copilot/` the Copilot CLI user files task sessions depend on, each with its
 * secrets masked. They are not folders of `.trackwall`: their files live in the state folder and Copilot CLI's home.
 */
export const SETTINGS_STORE_FOLDERS = ["trackwall", "copilot"] as const;
export type SettingsStoreFolder = (typeof SETTINGS_STORE_FOLDERS)[number];

/** Every folder the daemon keeps at the store's root besides `repos/`, in the order of a commit message. */
export const STORE_FOLDERS = [...WORKSPACE_STORE_FOLDERS, ...SETTINGS_STORE_FOLDERS] as const;
export type StoreFolder = (typeof STORE_FOLDERS)[number];

export const WorkspaceStore = z.object({
  /** `null` while the projects folder is not set. */
  dir: z.string().nullable(),
  /** The newest commit in the store, the last backup; `null` before the first one. */
  lastBackup: Commit.nullable(),
  /**
   * The address the store is pushed to, the one the user allowed (`localConfigRemote` in `workspace.yaml`, ADR-127),
   * without a user or token; `null` keeps the backups on this computer only.
   */
  pushesTo: z.string().nullable(),
  /**
   * The store's main remote (`origin` or the only one) as its config writes it, without a user or token: the address the
   * user can allow. It is not where the store is pushed, since an agent can change it; `null` without one.
   */
  remote: z.string().nullable(),
  /** Whether `remote` is the address the store is pushed to. */
  remoteAllowed: z.boolean(),
  /** Why `remote` cannot be allowed (not HTTPS or SSH, several addresses); `null` when it can. */
  remoteProblem: z.string().nullable(),
  push: WorkspaceStorePush,
  /**
   * Whether the store also keeps the workspace knowledge, routines, board and task templates (`storePlanAndKnowledge` in
   * `workspace.yaml`, ADR-298); off without the key, and off while the key cannot be read.
   */
  keepsPlanAndKnowledge: z.boolean(),
  /**
   * Whether the store also keeps `workspace.yaml` and the Copilot CLI user files, with their secrets masked
   * (`storeSettings` in `workspace.yaml`, ADR-299); off without the key, and off while the key cannot be read.
   */
  keepsSettings: z.boolean(),
  /**
   * Whether the store's last commit holds settings (`trackwall/` or `copilot/`, ADR-299). While `keepsSettings` is off,
   * they come from another computer or from this one before its state folder was made afresh, and turning it on replaces
   * them, so the user is told first.
   */
  settingsInStore: z.boolean(),
  /** Why the last backup did not finish (a file that cannot be read, a git error); `null` when it did. */
  problem: z.string().nullable(),
});
export type WorkspaceStore = z.infer<typeof WorkspaceStore>;

/**
 * Keys of `workspace.yaml` a restore from the store never writes (ADR-299): the store lies in the projects folder, so the
 * folder is already set when the store is read, the push address is allowed only by "Push to this remote" (ADR-127), and
 * what the store keeps is turned on only by its own setting, which asks before replacing settings the store holds.
 */
export const KEYS_NOT_RESTORED = [
  "projectsDir",
  "localConfigRemote",
  "storePlanAndKnowledge",
  "storeSettings",
] as const satisfies readonly WorkspaceKey[];

/**
 * Keys of `workspace.yaml` that decide what agents may run or read, where they work or push, where repos are cloned from,
 * or how many runs and tokens they spend (ADR-299). An agent can commit to
 * the store, so a restore shows them apart and writes each only once the user ticked it.
 */
export const TRUST_KEYS = [
  "worktreesDir",
  "gitProgram",
  "toolPermissions",
  "alwaysAllow",
  "sandbox",
  "agentSecrets",
  "sessionProfile",
  "supervisor",
  "javaNavigation",
  "dayStart",
  "repoHosts",
  "taskBranchPrefix",
  "autoReview",
  "supervisorModel",
  "retryModel",
  "taskTokenBudget",
] as const satisfies readonly WorkspaceKey[];

/** One thing a restore of the settings from the store would change (ADR-299). */
export const SettingsRestoreItem = z.object({
  /** `workspace:<key>`, `copilot:<file>`, or `workspace` for a store's `workspace.yaml` that cannot be read. */
  id: z.string(),
  /** What it is, as the user reads it: `repoHosts in workspace.yaml`, `mcp-config.json`. */
  label: z.string(),
  /** Whether it decides what agents may run or read (`TRUST_KEYS`, every Copilot CLI file), so it needs its own tick. */
  trust: z.boolean(),
  /** The text now: the key as YAML or the whole file, masked as the store keeps it; `null` when there is none. */
  current: z.string().nullable(),
  /**
   * The text after the restore, shown masked as the store keeps it so this computer's tokens never reach the list; the
   * restore itself writes this computer's values where the store's are masked and all around them is the same.
   */
  restored: z.string(),
  /** Whether the restored text still holds masked values the user fills in afterwards. */
  stillMasked: z.boolean(),
  /** Why it cannot be restored (a value this Trackwall does not read, a file that cannot be read); `null` when it can. */
  problem: z.string().nullable(),
});
export type SettingsRestoreItem = z.infer<typeof SettingsRestoreItem>;

export const SettingsRestore = z.object({
  /** The store's commit the items come from; a restore names it, so a store that moved since is refused. `null` without one. */
  commit: z.string().nullable(),
  /** Only what differs from this computer: the keys the store's `workspace.yaml` sets, then the Copilot CLI files. */
  items: z.array(SettingsRestoreItem),
});
export type SettingsRestore = z.infer<typeof SettingsRestore>;

/**
 * An address without the user and token an HTTP or HTTPS address may carry: `https://me:token@host/x` is
 * `https://host/x`. Everything up to the last `@` before the path goes, so a token with an `@` in it does not show
 * either. Any other address stays as it is: the user of `ssh://git@host/x` is no secret.
 */
export function withoutUserInfo(url: string): string {
  const match = /^(https?:\/\/)([^/]*)(.*)$/is.exec(url);
  if (!match) return url;
  const [, scheme = "", authority = "", rest = ""] = match;
  return `${scheme}${authority.slice(authority.lastIndexOf("@") + 1)}${rest}`;
}

const endpoint = apiEndpoints("local-config");

const RepoRequest = z.object({ repo: RepoId }).strict();

export const localConfigApi = {
  store: endpoint("store", z.object({}).strict(), WorkspaceStore),
  repo: endpoint("repo", RepoRequest, RepoLocalConfig),
  /** Every repo that has a local config file or a backup of one, by identifier (ADR-108); repos with neither are left out. */
  repos: endpoint("repos", z.object({}).strict(), z.array(RepoLocalConfig)),
  /**
   * Copies the files only the store has into the repo root, never over an existing file, and has git ignore them in
   * this clone (`.git/info/exclude`). Only from the UI, never from MCP: it writes into the user's repo.
   */
  restore: endpoint("restore", RepoRequest, RepoLocalConfig),
  /** Has git ignore the repo's local config files that it neither tracks nor ignores, in this clone only (`.git/info/exclude`). */
  ignore: endpoint("ignore", RepoRequest, RepoLocalConfig),
  /**
   * Pushes the store to its remote from now on (ADR-127): `remote` is the address as the user saw it in `store`, so a
   * remote that changed meanwhile is refused. Only from the UI, never from MCP: an agent must not choose where the backups go.
   */
  allowRemote: endpoint("allow-remote", z.object({ remote: z.string() }).strict(), WorkspaceStore),
  /** Pushes the store nowhere from now on (removes `localConfigRemote`). Only from the UI, like `allowRemote`. */
  stopPushing: endpoint("stop-pushing", z.object({}).strict(), WorkspaceStore),
  /**
   * Has the store keep the workspace knowledge, routines, board and task templates, or stop keeping them (ADR-298), and
   * brings the store up to date at once. Only from the UI, never from MCP: it decides what goes to the remote.
   */
  keepPlanAndKnowledge: endpoint("keep-plan-and-knowledge", z.object({ on: z.boolean() }).strict(), WorkspaceStore),
  /**
   * Has the store keep `workspace.yaml` and the Copilot CLI user files, or stop keeping them (ADR-299), and brings the
   * store up to date at once. While it is off and `settingsInStore`, turning it on is refused unless `replace` says the
   * user saw that the store's settings will be replaced. Only from the UI, never from MCP, like `keepPlanAndKnowledge`.
   */
  keepSettings: endpoint("keep-settings", z.object({ on: z.boolean(), replace: z.boolean() }).strict(), WorkspaceStore),
  /** What restoring the settings from the store's last commit would change on this computer (ADR-299). */
  settingsRestore: endpoint("settings-restore", z.object({}).strict(), SettingsRestore),
  /**
   * Restores the items the user ticked, from `commit`, the commit they looked at; a store that moved since is refused.
   * Only from the UI, never from MCP: it writes what agents may run.
   */
  restoreSettings: endpoint(
    "restore-settings",
    z.object({ commit: CommitHash, items: z.array(z.string()).min(1).max(64) }).strict(),
    SettingsRestore,
  ),
};
