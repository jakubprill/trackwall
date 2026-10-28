import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  CONFIG_ENTRIES,
  type ConfigEntry,
  ConfigEntryId,
  type ConfigFilesReport,
  countLabel,
  DEFAULT_WORKTREES_DIR_NAME,
  LOCAL_CONFIG_STORE_DIR,
  type LocalConfigStore,
  MISE_CONFIG_NAME,
  REMOVED_REPOS_DIR,
  type WorkspaceKeyState,
  type WorkspaceKeysRead,
  workspaceKeysSummary,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";

/**
 * The `config-files` module (§4.16, ADR-108): every file and folder Trackwall reads or writes on this computer, where it
 * is, its state and what is in it in one line, and each key of `workspace.yaml` with its value and where it comes from,
 * for the person who wants to know what is set and where. It only reads, and it never lists a file that holds the daemon
 * token (`daemon.json`, a session's files). What each entry is for lives in `CONFIG_ENTRIES`, so the view and its
 * documentation say the same.
 */

/** The entries in Trackwall's state folder, whose paths the facade knows. */
type StateEntryId =
  | "workspace-file"
  | "tasks-file"
  | "resumable-sessions-file"
  | "last-supervisor-file"
  | "day-start-file"
  | "cards-dir"
  | "logs-dir"
  | "legacy-worktrees-dir";

/** Copilot CLI's `config.json` as the doctor reads it (`trustedFolders`); the facade's wiring checks the two agree. */
type CopilotTrust =
  | { kind: "read"; file: string; folders: string[] }
  | { kind: "missing"; file: string }
  | { kind: "unreadable"; file: string; message: string };

/** What mise gives sessions in the projects folder (ADR-93): variable names, the secrets among them, or why it gave nothing. */
interface ProjectsMiseEnv {
  variables: string[];
  secrets: string[];
  problem: string | null;
}

export interface ConfigFilesDeps {
  stateDir: ConfigFilesReport["stateDir"];
  statePaths: Record<StateEntryId, string>;
  /** `null` while the projects folder is not set or `workspace.yaml` cannot say it. */
  projectsDir: () => Promise<string | null>;
  /** The task worktrees folder new tasks get; `null` while it cannot be known. */
  worktreesDir: () => Promise<string | null>;
  /** Throws when `workspace.yaml` as a whole cannot be read. */
  workspaceKeys: () => WorkspaceKeysRead;
  env: () => Promise<NodeJS.ProcessEnv>;
  copilotTrust: (env: NodeJS.ProcessEnv) => Promise<CopilotTrust>;
  trustedFolderOf: (dir: string, folders: readonly string[]) => string | null;
  projectsMiseEnv: () => Promise<ProjectsMiseEnv>;
  localConfigStore: () => Promise<LocalConfigStore>;
  openEditor: (path: string) => void;
  openFolder: (dir: string) => void;
}

/** An entry as found; `path` is `null` while the projects folder is not set. */
type Found = Omit<ConfigEntry, "id">;

/** What every entry is found from, read once per list. */
interface Context {
  projectsDir: string | null;
  worktreesDir: string | null;
  copilot: CopilotTrust;
  keys: KeysOrProblem;
}

/** `content`: what is in each entry, which runs mise; `path`: only where it is, to open it. */
type Depth = "content" | "path";

export class ConfigFiles {
  readonly #deps: ConfigFilesDeps;

  constructor(deps: ConfigFilesDeps) {
    this.#deps = deps;
  }

  async list(): Promise<ConfigFilesReport> {
    const ctx = await this.#context();
    const entries = await Promise.all(
      ConfigEntryId.options.map(async (id): Promise<ConfigEntry> => ({ id, ...(await this.#find(id, ctx, "content")) })),
    );
    return {
      stateDir: this.#deps.stateDir,
      places: { state: this.#deps.stateDir.path, projects: ctx.projectsDir, copilot: dirname(ctx.copilot.file) },
      entries,
      workspaceKeys: withDefaultWorktreesDir(ctx.keys.read.keys, ctx.worktreesDir),
      unknownWorkspaceKeys: ctx.keys.read.unknown,
    };
  }

  async openInEditor(id: ConfigEntryId): Promise<void> {
    if (CONFIG_ENTRIES[id].kind !== "file") throw new DomainError("bad_request", `${id} is a folder; show it in its folder instead`);
    this.#deps.openEditor(await this.#existingPath(id));
  }

  async showInFolder(id: ConfigEntryId): Promise<void> {
    const path = await this.#existingPath(id);
    this.#deps.openFolder(CONFIG_ENTRIES[id].kind === "folder" ? path : dirname(path));
  }

  async #context(): Promise<Context> {
    const env = await this.#deps.env();
    const [projectsDir, worktreesDir, copilot] = await Promise.all([
      this.#deps.projectsDir(),
      this.#deps.worktreesDir(),
      this.#deps.copilotTrust(env),
    ]);
    return { projectsDir, worktreesDir, copilot, keys: workspaceKeysOrProblem(this.#deps.workspaceKeys) };
  }

  /** The path of an entry that is there; the daemon picks it from its own list, never from a path a client sent. */
  async #existingPath(id: ConfigEntryId): Promise<string> {
    const found = await this.#find(id, await this.#context(), "path");
    if (found.path === null || found.state === "missing") throw new DomainError("not_found", `${id} is not on this computer`);
    return found.path;
  }

  async #find(id: ConfigEntryId, ctx: Context, depth: Depth): Promise<Found> {
    switch (id) {
      case "workspace-file":
        return workspaceFile(this.#deps.statePaths[id], ctx.keys);
      case "tasks-file":
      case "resumable-sessions-file":
      case "last-supervisor-file":
      case "day-start-file":
      case "cards-dir":
      case "logs-dir":
      case "legacy-worktrees-dir":
        return plainEntry(this.#deps.statePaths[id]);
      case "projects-mise-config":
        return this.#projectsMiseConfig(ctx.projectsDir, depth);
      case "local-config-store":
        return this.#localConfigStore(ctx.projectsDir);
      case "task-worktrees-dir":
        return taskWorktrees(ctx.worktreesDir);
      case "removed-repos-dir":
        return removedRepos(ctx.projectsDir);
      case "copilot-config":
        return this.#copilotConfig(ctx);
    }
  }

  /** The projects folder's own mise config, the first by name; mise also reads the folders above it and its global config. */
  async #projectsMiseConfig(projectsDir: string | null, depth: Depth): Promise<Found> {
    if (projectsDir === null) return notSet("mise.toml");
    const names = (await readdir(projectsDir).catch(() => [])).filter((name) => MISE_CONFIG_NAME.test(name)).sort();
    const name = names.find((n) => n.toLowerCase() === "mise.toml") ?? names[0];
    if (name === undefined) return { name: "mise.toml", path: join(projectsDir, "mise.toml"), state: "missing", detail: null };
    const path = join(projectsDir, name);
    if (depth === "path") return { name, path, state: "present", detail: null };
    const env = await this.#deps.projectsMiseEnv();
    if (env.problem === null) return { name, path, state: "present", detail: miseEnvDetail(env) };
    // mise also reads the folders above and its global config, and shortens paths to `~`, so its message cannot be pinned
    // on this file: the file stays found and the message is its detail.
    return { name, path, state: "present", detail: env.problem };
  }

  async #localConfigStore(projectsDir: string | null): Promise<Found> {
    if (projectsDir === null) return notSet(LOCAL_CONFIG_STORE_DIR);
    const store = await this.#deps.localConfigStore();
    if (store.dir === null) return notSet(LOCAL_CONFIG_STORE_DIR);
    const found = await plainEntry(store.dir);
    if (found.state === "missing") return found;
    if (store.problem !== null) return { ...found, state: "invalid", detail: store.problem };
    return { ...found, detail: storeDetail(store) };
  }

  #copilotConfig({ copilot, projectsDir }: Context): Found {
    const at = { name: basename(copilot.file), path: copilot.file };
    if (copilot.kind === "missing") return { ...at, state: "missing", detail: null };
    if (copilot.kind === "unreadable") return { ...at, state: "invalid", detail: copilot.message };
    if (projectsDir === null) return { ...at, state: "present", detail: trustsDetail(copilot.folders) };
    const folder = this.#deps.trustedFolderOf(projectsDir, copilot.folders);
    const detail = folder === null ? "does not trust the projects folder, so it asks in every repo" : `trusts ${folder}`;
    return { ...at, state: "present", detail };
  }
}

/** Without a projects folder an entry in it has its usual name and no path. */
function notSet(name: string): Found {
  return { name, path: null, state: "missing", detail: "set the projects folder first" };
}

async function taskWorktrees(dir: string | null): Promise<Found> {
  if (dir === null) return notSet(DEFAULT_WORKTREES_DIR_NAME);
  const name = basename(dir);
  const repos = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (repos === null) return { name, path: dir, state: "missing", detail: null };
  const counts = await Promise.all(
    repos
      .filter((r) => r.isDirectory())
      .map((r) =>
        readdir(join(dir, r.name)).then(
          (branches) => branches.length,
          () => 0,
        ),
      ),
  );
  const worktrees = counts.reduce((a, b) => a + b, 0);
  return { name, path: dir, state: "present", detail: countLabel(worktrees, { one: "worktree", other: "worktrees" }) };
}

async function removedRepos(projectsDir: string | null): Promise<Found> {
  if (projectsDir === null) return notSet(REMOVED_REPOS_DIR);
  const path = join(projectsDir, REMOVED_REPOS_DIR);
  const repos = await readdir(path).catch(() => null);
  if (repos === null) return { name: REMOVED_REPOS_DIR, path, state: "missing", detail: null };
  return { name: REMOVED_REPOS_DIR, path, state: "present", detail: countLabel(repos.length, { one: "repo", other: "repos" }) };
}

/** The default task worktrees folder is a path in the projects folder, more use than "the default". */
function withDefaultWorktreesDir(keys: WorkspaceKeyState[], worktreesDir: string | null): WorkspaceKeyState[] {
  return keys.map((k) => (k.key === "worktreesDir" && k.from === "default" && worktreesDir !== null ? { ...k, value: worktreesDir } : k));
}

/** The keys of `workspace.yaml`, or why the file as a whole cannot be read (then no keys). */
interface KeysOrProblem {
  read: WorkspaceKeysRead;
  problem: string | null;
}

function workspaceKeysOrProblem(read: () => WorkspaceKeysRead): KeysOrProblem {
  try {
    return { read: read(), problem: null };
  } catch (err) {
    return { read: { keys: [], unknown: [] }, problem: messageOf(err) };
  }
}

async function workspaceFile(path: string, keys: KeysOrProblem): Promise<Found> {
  const found = await plainEntry(path);
  if (keys.problem !== null) return { ...found, state: "invalid", detail: keys.problem };
  if (found.state === "missing") return found;
  const summary = workspaceKeysSummary(keys.read);
  return { ...found, state: summary.state === "broken" ? "invalid" : "present", detail: summary.text };
}

/** A file by its size, a folder by how many entries it has. */
async function plainEntry(path: string): Promise<Found> {
  const name = basename(path);
  const info = await stat(path).catch(() => null);
  if (info === null) return { name, path, state: "missing", detail: null };
  if (!info.isDirectory()) return { name, path, state: "present", detail: sizeLabel(info.size) };
  const items = await readdir(path).then(
    (names) => names.length,
    () => 0,
  );
  return { name, path, state: "present", detail: countLabel(items, { one: "item", other: "items" }) };
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function miseEnvDetail({ variables, secrets }: ProjectsMiseEnv): string {
  if (variables.length === 0) return "mise gives sessions no variables here, or mise is not installed";
  const vars = countLabel(variables.length, { one: "variable", other: "variables" });
  return secrets.length === 0 ? `${vars} for sessions` : `${vars} for sessions, secret: ${secrets.join(", ")}`;
}

function storeDetail(store: LocalConfigStore): string {
  const backup =
    store.lastBackup === null ? "nothing backed up yet" : `last backup ${store.lastBackup.date.slice(0, 16).replace("T", " ")}`;
  if (store.remote === null) return `${backup}, on this computer only`;
  if (store.push.kind === "failed") return `${backup}, push to ${store.remote} failed: ${store.push.message}`;
  if (store.push.kind === "none") return `${backup}, remote ${store.remote}`;
  return `${backup}, pushed to ${store.remote}`;
}

function trustsDetail(folders: readonly string[]): string {
  return folders.length === 0 ? "trusts no folder" : `trusts ${folders.join(", ")}`;
}
