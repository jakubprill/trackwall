import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AgentSecrets,
  DayStartSettings,
  GraphConfig,
  JavaNavigationSettings,
  type RepoHost,
  RepoHosts,
  RepoTagRules,
  SupervisorSettings,
  ToolPermissionRules,
  WorkspaceKey,
  type WorkspaceKeyState,
  type WorkspaceKeysRead,
} from "@trackwall/protocol";
import { type Document, isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError } from "../../infra/errors.ts";
import { isFullPath, NOT_FULL_PATH, NOT_FULL_PROGRAM_PATH } from "./full-path.ts";
import { type WorkspaceKeyValues, workspaceKeyValue } from "./workspace-key-value.ts";

/**
 * `workspace.yaml` (§4.5, ADR-13): the workspace configuration, which the user can edit by hand and keep
 * in a private repo. Read on every use, so a manual edit works without restarting the daemon. A write changes
 * only one key (`projectsDir`, `worktreesDir`, `gitProgram`, `repoHosts` or `javaNavigation`, which the Java navigation install writes; `repoTags`, `graph`, `toolPermissions`, `dayStart`, `supervisor` and `agentSecrets` only by hand) and keeps comments and the other keys,
 * including the `repos` list from version 0.2.0, which is no longer read (ADR-18): it is the user's file, so removing it is up to them.
 */

/**
 * Keys read separately, so a bad entry in one does not break the other: a typo in the repo hosts does not take away the repo list,
 * and the message says which key to fix.
 */
const Keys: { [K in WorkspaceKey]: z.ZodType<WorkspaceKeyValues[K], unknown> } = {
  // YAML reads an empty key (`projectsDir:`) as `null`, the same as a missing key.
  projectsDir: z
    .string()
    .refine((dir) => isFullPath(dir), NOT_FULL_PATH)
    .nullish()
    .transform((dir) => dir ?? null),
  // Where new task worktrees go (ADR-84); a missing key means `.trackwall/worktrees` in the projects folder.
  worktreesDir: z
    .string()
    .refine((dir) => isFullPath(dir), NOT_FULL_PATH)
    .nullish()
    .transform((dir) => dir ?? null),
  // The git for local git calls (ADR-112); a missing key means git from `PATH`.
  gitProgram: z
    .string()
    .refine((path) => isFullPath(path), NOT_FULL_PROGRAM_PATH)
    .nullish()
    .transform((path) => path ?? null),
  // Repo hosts (ADR-19); a missing key means no repo hosts, because only the user knows the GitLab address.
  repoHosts: RepoHosts.nullish().transform((hosts) => hosts ?? []),
  // Repo tag rules (ADR-25); only by hand in the file, because only the user knows team and group names.
  repoTags: RepoTagRules.nullish().transform((rules) => rules ?? {}),
  // Package aliases and manual graph edges (ADR-29); only by hand in the file, like `repoTags`.
  graph: GraphConfig.nullish().transform((graph) => graph ?? GraphConfig.parse({})),
  // Tool permission rules for Copilot CLI sessions (ADR-66); only by hand, like `repoTags`.
  toolPermissions: ToolPermissionRules.nullish().transform((rules) => rules ?? []),
  // The user's addition to the day start's first message (ADR-70); only by hand, like `repoTags`.
  dayStart: DayStartSettings.nullish().transform((settings) => settings ?? null),
  // Whether the supervisor may change code itself (ADR-78); only by hand, like `repoTags`.
  supervisor: SupervisorSettings.nullish().transform((settings) => settings ?? { changesCode: false }),
  // The secrets from mise that the tools of sessions get (ADR-93); only by hand, like `repoTags`.
  agentSecrets: AgentSecrets.nullish().transform((names) => names ?? []),
  // The Java language server for tasks (ADR-99); by hand or by installing it in Settings › Agents (ADR-123).
  javaNavigation: JavaNavigationSettings.refine(
    (settings) => [settings.jdtls, settings.java, settings.lombok].every((path) => path === null || isFullPath(path)),
    "jdtls, java and lombok must be full paths",
  )
    .nullish()
    .transform((settings) => settings ?? null),
};
type Key = WorkspaceKey;

export class WorkspaceFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The projects folder (ADR-18); `null` until it is set. */
  projectsDir(): string | null {
    return this.get("projectsDir", Keys.projectsDir);
  }

  /** The task worktrees folder (ADR-84); `null` for the default. */
  worktreesDir(): string | null {
    return this.get("worktreesDir", Keys.worktreesDir);
  }

  /** The git program for local git calls (ADR-112); `null` for git from `PATH`. */
  gitProgram(): string | null {
    return this.get("gitProgram", Keys.gitProgram);
  }

  /** Repo hosts in file order (ADR-19). */
  repoHosts(): RepoHost[] {
    return this.get("repoHosts", Keys.repoHosts);
  }

  /** Repo tag rules (`repoTags`, ADR-25): a tag and patterns of the identifier or remote repo address. */
  repoTagRules(): RepoTagRules {
    return this.get("repoTags", Keys.repoTags);
  }

  /** Package aliases and manual graph edges (`graph`, ADR-29). */
  graphConfig(): GraphConfig {
    return this.get("graph", Keys.graph);
  }

  /** Tool permission rules (`toolPermissions`, ADR-66) in file order. */
  toolPermissionRules(): ToolPermissionRules {
    return this.get("toolPermissions", Keys.toolPermissions);
  }

  /** The day start settings (`dayStart`, ADR-70); `null` without the key. */
  dayStartSettings(): DayStartSettings | null {
    return this.get("dayStart", Keys.dayStart);
  }

  /** The supervisor settings (`supervisor`, ADR-78); the defaults without the key. */
  supervisorSettings(): SupervisorSettings {
    return this.get("supervisor", Keys.supervisor);
  }

  /** The secrets from mise that the tools of sessions get (`agentSecrets`, ADR-93); none without the key. */
  agentSecrets(): AgentSecrets {
    return this.get("agentSecrets", Keys.agentSecrets);
  }

  /** The Java language server for tasks (`javaNavigation`, ADR-99); `null` without the key. */
  javaNavigation(): JavaNavigationSettings | null {
    return this.get("javaNavigation", Keys.javaNavigation);
  }

  /**
   * Each key with its value in one line, whether the file has it, its line and why it cannot be read, and the keys
   * Trackwall does not read, for the view of the config files and the doctor (ADR-108). Throws, like every read, when the
   * file as a whole cannot be read.
   */
  keyStates(): WorkspaceKeysRead {
    const { doc, lines } = this.read();
    const raw: unknown = doc.toJS();
    const config = isRecord(raw) ? raw : {};
    const keys = WorkspaceKey.options.map((key) => keyState(key, config[key] ?? null, keyLine(doc, lines, key)));
    const known = new Set<string>(WorkspaceKey.options);
    const unknown = Object.keys(config)
      .filter((name) => !known.has(name))
      .map((name) => ({ name, line: keyLine(doc, lines, name) }));
    return { keys, unknown };
  }

  setProjectsDir(dir: string): void {
    this.set("projectsDir", dir);
  }

  /** `null` removes the key, so that the file says nothing about a setting the user did not choose. */
  setWorktreesDir(dir: string | null): void {
    this.set("worktreesDir", dir);
  }

  /** `null` removes the key, like `setWorktreesDir`. */
  setGitProgram(path: string | null): void {
    this.set("gitProgram", path);
  }

  /** Without a Lombok jar the key has no `lombok` line, rather than `lombok: null`. */
  setJavaNavigation(settings: JavaNavigationSettings): void {
    const { lombok, ...paths } = settings;
    this.set("javaNavigation", lombok === null ? paths : settings);
  }

  setRepoHosts(hosts: RepoHost[]): void {
    this.set("repoHosts", hosts);
  }

  private get<T>(key: Key, schema: z.ZodType<T>): T {
    // `load` guarantees a map or an empty document.
    const config: Record<string, unknown> = this.load().toJS() ?? {};
    const parsed = schema.safeParse(config[key] ?? null);
    if (!parsed.success) throw this.invalid(`${key}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  /** `null` removes the key. */
  private set(key: Key, value: unknown): void {
    const doc = this.load();
    if (value === null) doc.delete(key);
    else doc.set(key, value);
    this.save(doc);
  }

  private load(): Document {
    return this.read().doc;
  }

  /** The document with its line counter, for the line of a key. */
  private read(): { doc: Document; lines: LineCounter } {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      text = "";
    }
    const lines = new LineCounter();
    const doc = parseDocument(text, { lineCounter: lines });
    if (doc.errors.length > 0) throw this.invalid(doc.errors.map((e) => e.message).join("; "));
    if (doc.contents !== null && !isMap(doc.contents)) throw this.invalid("the file must be a map of keys, e.g. `projectsDir: <path>`");
    return { doc, lines };
  }

  private save(doc: Document): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomic(this.path, doc.toString());
  }

  private invalid(details: string): DomainError {
    return new DomainError("invalid_config", `${this.path} is invalid: ${details}`);
  }
}

/** A key that YAML reads as `null` (`dayStart:` with every line commented out) is a default, like a missing key. */
function keyState<K extends WorkspaceKey>(key: K, raw: unknown, line: number | null): WorkspaceKeyState {
  const parsed = Keys[key].safeParse(raw);
  if (!parsed.success) return { key, from: "file", value: null, line, problem: z.prettifyError(parsed.error) };
  const from = raw === null ? "default" : "file";
  return { key, from, value: workspaceKeyValue[key](parsed.data), line: from === "file" ? line : null, problem: null };
}

/** The line of `key` in the file, from 1; `null` without the key. `read` guarantees a map or an empty document. */
function keyLine(doc: Document, lines: LineCounter, key: string): number | null {
  if (!isMap(doc.contents)) return null;
  const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === key);
  const offset = pair && isScalar(pair.key) ? pair.key.range?.[0] : undefined;
  return offset === undefined ? null : lines.linePos(offset).line;
}

/** `read` guarantees a map or an empty document, which YAML gives as an object or `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
