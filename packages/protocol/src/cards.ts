import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { Evidence } from "./evidence.ts";
import { ConsumedHttp, Dto, ProvidedApp, ProvidedEndpoint } from "./http.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `cards` module (§4.6, ADR-25): the repo card, that is facts extracted deterministically from build and
 * configuration files in the last commit, and repo tags computed from the card and from the rules in `workspace.yaml`.
 * Every action is `POST /api/cards/<action>`. No LLM: every field has evidence (file and line).
 */

/**
 * A build system or package manager whose build file is in the repo. `npm`, `pnpm`, `yarn` and `bun` are told apart by
 * the `packageManager` field or the lockfile in the directory with `package.json`.
 */
export const BuildTool = z.enum(["maven", "gradle", "npm", "pnpm", "yarn", "bun"]);
export type BuildTool = z.infer<typeof BuildTool>;

/** A build file that belongs to the repo's build: the root, and the modules or packages it lists. */
export const BuildFile = z.object({
  path: z.string(),
  tool: BuildTool,
  /** The name from the file (`artifactId`, `name` from `package.json`, the Gradle project name); `null` when there is none. */
  name: z.string().nullable(),
  /** The build file that lists this one as a module or workspace package; `null` for the build root. */
  memberOf: z.string().nullable(),
});
export type BuildFile = z.infer<typeof BuildFile>;

/**
 * Package namespace: Maven coordinates (`group:artifact`, also from Gradle), npm names and Gradle plugin ids. Graph
 * edges join what a repo provides with what another uses, within the same namespace.
 */
export const PackageEcosystem = z.enum(["maven", "npm", "gradle-plugin"]);
export type PackageEcosystem = z.infer<typeof PackageEcosystem>;

/** A package the repo builds and another repo can take as a dependency. */
export const ProvidedPackage = z.object({
  kind: z.literal("package"),
  ecosystem: PackageEcosystem,
  name: z.string(),
  /** The version from the build file after substituting properties; `null` when the file does not give one. */
  version: z.string().nullable(),
  evidence: Evidence,
});
export type ProvidedPackage = z.infer<typeof ProvidedPackage>;

/** A package from outside the repo that the repo uses: a dependency, a Maven parent, a BOM, a build plugin. */
export const ConsumedPackage = ProvidedPackage.extend({
  /**
   * The same type as in `ProvidedPackage`, a different meaning: the version as it stands in the file (an npm range, a Maven
   * property that could not be substituted); `null` without a version.
   */
  version: z.string().nullable(),
  /**
   * The kind of use from the file: a Maven scope (`compile`, `test`, `import`…), `parent`, `plugin`, a Gradle
   * configuration (`implementation`…) or a `package.json` field (`dependencies`, `devDependencies`…).
   */
  scope: z.string(),
});
export type ConsumedPackage = z.infer<typeof ConsumedPackage>;

/** What the repo provides: packages, Spring Boot applications and their HTTP endpoints (ADR-30); topics later (§4.6). */
export const Provided = z.discriminatedUnion("kind", [ProvidedPackage, ProvidedApp, ProvidedEndpoint]);
export type Provided = z.infer<typeof Provided>;

/** What the repo uses: packages and HTTP clients (ADR-30); topics later (§4.6). */
export const Consumed = z.discriminatedUnion("kind", [ConsumedPackage, ConsumedHttp]);
export type Consumed = z.infer<typeof Consumed>;

/** A tool version the repo requires: from the mise config or from a file that gives it in its own way. */
export const ToolRequirement = z.object({
  /** The tool name as mise knows it (`java`, `node`, `pnpm`, `maven`…). */
  tool: z.string(),
  version: z.string(),
  /**
   * `mise`: `[tools]` in the mise config or `.tool-versions`, which mise reads directly. `hint`: a version from another
   * file (`.nvmrc`, `engines.node`, `maven.compiler.release`…) that mise may or may not take into account.
   */
  source: z.enum(["mise", "hint"]),
  evidence: Evidence,
});
export type ToolRequirement = z.infer<typeof ToolRequirement>;

/** A mise task saved in the commit: a `[tasks]` entry of the mise config in the repo root or a file in the mise task directory. */
export const DeclaredMiseTask = z.object({
  /**
   * The name from the config, or the file path in the mise task directory with `:` (`mise-tasks/db/reset` is `db:reset`,
   * `_default` is the directory name); the card does not shorten extensions mise may drop.
   */
  name: z.string(),
  evidence: Evidence,
});
export type DeclaredMiseTask = z.infer<typeof DeclaredMiseTask>;

/**
 * The repo's mise config from the commit (ADR-34): the mise config files in the root and the saved tasks. Without mise
 * tasks a repo has nothing to run the batch command or a mise task from the UI on, so it gets the tag `no-mise`. mise tasks
 * from the user's global config and from files in `task_config.includes` are not counted here; `mise tasks ls` gives
 * the full list (§4.7).
 */
export const MiseSetup = z.object({
  configFiles: z.array(z.string()),
  tasks: z.array(DeclaredMiseTask),
  /** `false` when the card did not read one of the config files (limits) or the commit's file list was cut at its limit: then it is unknown whether the repo has mise tasks. */
  complete: z.boolean(),
});
export type MiseSetup = z.infer<typeof MiseSetup>;

/**
 * A mechanism detected in the repo: a framework, a way of communicating or deploying. An inventory, not a judgement: it
 * says the repo uses it, and the evidence says how that is known.
 */
export const MechanismId = z.enum([
  "spring-boot",
  "feign",
  "webclient",
  "openapi",
  "kafka",
  "rabbitmq",
  "eureka",
  "config-server",
  "config-client",
  "kubernetes",
  "helm",
  "docker",
  "react",
  "angular",
  "vue",
  "svelte",
  "express",
  "nestjs",
]);
export type MechanismId = z.infer<typeof MechanismId>;

export const MechanismEvidence = Evidence.extend({
  /** What points to the mechanism at this spot, for example `org.springframework.cloud:spring-cloud-starter-openfeign`. */
  detail: z.string(),
});
export type MechanismEvidence = z.infer<typeof MechanismEvidence>;

export const Mechanism = z.object({
  id: MechanismId,
  /** At most the first few pieces of evidence; one is enough for the mechanism to be on the card. */
  evidence: z.array(MechanismEvidence).min(1),
});
export type Mechanism = z.infer<typeof Mechanism>;

/**
 * What kind of gap a card problem is (ADR-80), so the UI and MCP can tell a missing file from a cut list without reading
 * the message: `files-not-read` a file or files the card did not read (read limits, a failed search), `file-invalid` a
 * file the extractor could not parse, `parse-incomplete` Java or Kotlin without syntax trees (no request and response
 * types, DTOs missing), `truncated` a list the card keeps only the first part of, or a type only its beginning,
 * `no-endpoints` a Spring web app the card found no endpoint in (ADR-116: the controllers may come from a library, a
 * language or style the card does not read, or the app may have none).
 */
export const CardProblemCode = z.enum(["files-not-read", "file-invalid", "parse-incomplete", "truncated", "no-endpoints"]);
export type CardProblemCode = z.infer<typeof CardProblemCode>;

/** Something the card could not read or shows only in part; the rest of the card is made without it. `path` is a file or a module directory, empty for the repo root or the whole repo. */
export const CardProblem = z.object({ code: CardProblemCode, path: z.string(), message: z.string() });
export type CardProblem = z.infer<typeof CardProblem>;

/**
 * The repo card for one commit. It depends only on the commit's tree, so the daemon computes it once per commit and
 * keeps it in a cache (ADR-25).
 */
export const RepoCard = z.object({
  /** The full hash of the commit the files were read from. */
  commit: z.string(),
  buildFiles: z.array(BuildFile),
  /**
   * Packages from the repo (without private npm packages, `"private": true`, which nobody outside the repo installs),
   * Spring Boot applications and HTTP endpoints.
   */
  provides: z.array(Provided),
  /** Packages from outside the repo, each once (first occurrence; packages from the same repo left out), and HTTP clients. */
  consumes: z.array(Consumed),
  /** DTOs of the repo's HTTP endpoints, in the order found from the endpoints (ADR-38). */
  dtos: z.array(Dto),
  /**
   * Whether the card traced which client calls each endpoint reaches (`ProvidedEndpoint.reaches`, ADR-82): `false` when
   * the repo has Kotlin code, which is not read yet, or not every Java file was read and parsed (then `problems` say
   * why). A card without endpoints
   * tells by this whether its client calls come from no endpoint or from code the card did not trace.
   */
  reachTraced: z.boolean(),
  tools: z.array(ToolRequirement),
  mise: MiseSetup,
  mechanisms: z.array(Mechanism),
  problems: z.array(CardProblem),
});
export type RepoCard = z.infer<typeof RepoCard>;

/** A tag name: lowercase letters, digits and `-`, like `frontend` or `core-api`; shown in the UI with a leading `#`. */
export const TagName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "tag name: lowercase letters, digits and '-', not starting with '-'");
export type TagName = z.infer<typeof TagName>;

/** The tag of a repo without mise tasks in the commit (ADR-34); the UI marks it in the repo list, because such a repo has nothing to run. */
export const NO_MISE_TAG = "no-mise";

/**
 * The tag of a repo with mise tasks in files git does not keep (`mise.local.toml`, a `mise.toml` kept out of git, ADR-110):
 * only this clone has them, and the local config store keeps their backup.
 */
export const LOCAL_MISE_TAG = "local-mise";

/** A repo tag with the reason the repo got it (a sentence for a person, for example "react dependency in package.json"). */
export const RepoTag = z.object({ name: TagName, reason: z.string() });
export type RepoTag = z.infer<typeof RepoTag>;

/**
 * Tag rules from `workspace.yaml` (`repoTags`): a tag and patterns, one of which has to match the repo identifier or
 * the repo's remote address. `*` is any string without `/`, `**` also with `/`, for example `core-api: ["*-core",
 * "gitlab.example.com/core/**"]`. This keeps company team and group names in the user's configuration (ADR-7).
 */
export const RepoTagRules = z.record(TagName, z.array(z.string().min(1).max(300)).min(1));
export type RepoTagRules = z.infer<typeof RepoTagRules>;

export const RepoCardResult = z.object({
  repo: RepoId,
  /** `null` in a repo without commits: there is nothing to read from. */
  card: RepoCard.nullable(),
  /** Tags from the card and from the `repoTags` rules, by name. */
  tags: z.array(RepoTag),
});
export type RepoCardResult = z.infer<typeof RepoCardResult>;

/** The tags of one repo in the list, or the reason there are none (git cannot read the repo). */
export const RepoTags = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), repo: RepoId, tags: z.array(RepoTag) }),
  z.object({ kind: z.literal("unavailable"), repo: RepoId, message: z.string() }),
]);
export type RepoTags = z.infer<typeof RepoTags>;

/**
 * The card warm-up (ADR-63): the daemon computes the cards of new and changed repos in the background. `total` counts the
 * repos handed to it since it was last idle and `done` the ones finished, also those whose card was already in the cache.
 */
export const CardWarmupProgress = z.object({
  running: z.boolean(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type CardWarmupProgress = z.infer<typeof CardWarmupProgress>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/cards/${action}`, request, data };
}

export const cardsApi = {
  /** The repo card from the last commit; the first request for a commit reads the files from git, later ones take it from the cache. */
  card: endpoint("card", z.object({ repo: RepoId }).strict(), RepoCardResult),
  /** The tags of every repo in the projects folder, in the order of the repo list. */
  tags: endpoint("tags", z.object({}).strict(), z.array(RepoTags)),
  /** The progress of the card warm-up, from daemon memory. */
  warmup: endpoint("warmup", z.object({}).strict(), CardWarmupProgress),
};
