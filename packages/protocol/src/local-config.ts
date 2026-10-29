import { z } from "zod";
import { WORKTREE_INCLUDE_FILE } from "./agents.ts";
import type { Endpoint } from "./api.ts";
import { Commit, RepoId } from "./workspace.ts";

/**
 * Contract of the `local-config` module (§4.13, ADR-86): the files a repo keeps outside git on purpose, backed up into
 * the local config store, a git repo in the projects folder, and restored from it into a new clone. Every action is
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
export const LocalConfigPush = z.discriminatedUnion("kind", [
  /** No push yet: the store has no remote, or nothing was backed up since the daemon started. */
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("ok"), at: z.string() }),
  z.object({ kind: z.literal("failed"), at: z.string(), message: z.string() }),
]);
export type LocalConfigPush = z.infer<typeof LocalConfigPush>;

export const LocalConfigStore = z.object({
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
  push: LocalConfigPush,
  /** Why the last backup did not finish (a file that cannot be read, a git error); `null` when it did. */
  problem: z.string().nullable(),
});
export type LocalConfigStore = z.infer<typeof LocalConfigStore>;

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

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/local-config/${action}`, request, data };
}

const RepoRequest = z.object({ repo: RepoId }).strict();

export const localConfigApi = {
  store: endpoint("store", z.object({}).strict(), LocalConfigStore),
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
  allowRemote: endpoint("allow-remote", z.object({ remote: z.string() }).strict(), LocalConfigStore),
};
