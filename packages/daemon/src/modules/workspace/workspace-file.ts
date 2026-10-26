import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DayStartSettings,
  GraphConfig,
  type RepoHost,
  RepoHosts,
  RepoTagRules,
  SupervisorSettings,
  ToolPermissionRules,
} from "@trackwall/protocol";
import { type Document, isMap, parseDocument } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError } from "../../infra/errors.ts";
import { isFullPath, NOT_FULL_PATH } from "./full-path.ts";

/**
 * `workspace.yaml` (§4.5, ADR-13): the workspace configuration, which the user can edit by hand and keep
 * in a private repo. Read on every use, so a manual edit works without restarting the daemon. A write changes
 * only one key (`projectsDir` or `repoHosts`; `repoTags`, `graph`, `toolPermissions`, `dayStart` and `supervisor` only by hand) and keeps comments and the other keys,
 * including the `repos` list from version 0.2.0, which is no longer read (ADR-18): it is the user's file, so removing it is up to them.
 */

/**
 * Keys read separately, so a bad entry in one does not break the other: a typo in the repo hosts does not take away the repo list,
 * and the message says which key to fix.
 */
const Keys = {
  // YAML reads an empty key (`projectsDir:`) as `null`, the same as a missing key.
  projectsDir: z
    .string()
    .refine((dir) => isFullPath(dir), NOT_FULL_PATH)
    .nullish()
    .transform((dir) => dir ?? null),
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
  supervisor: SupervisorSettings.nullish().transform((settings) => settings ?? SupervisorSettings.parse({})),
};
type Key = keyof typeof Keys;

export class WorkspaceFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The projects folder (ADR-18); `null` until it is set. */
  projectsDir(): string | null {
    return this.get("projectsDir", Keys.projectsDir);
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

  setProjectsDir(dir: string): void {
    this.set("projectsDir", dir);
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

  private set(key: Key, value: unknown): void {
    const doc = this.load();
    doc.set(key, value);
    this.save(doc);
  }

  private load(): Document {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      text = "";
    }
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw this.invalid(doc.errors.map((e) => e.message).join("; "));
    if (doc.contents !== null && !isMap(doc.contents)) throw this.invalid("the file must be a map of keys, e.g. `projectsDir: <path>`");
    return doc;
  }

  private save(doc: Document): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomic(this.path, doc.toString());
  }

  private invalid(details: string): DomainError {
    return new DomainError("invalid_config", `${this.path} is invalid: ${details}`);
  }
}
