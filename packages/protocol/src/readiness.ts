import { z } from "zod";
import { apiEndpoints } from "./api.ts";
import { ConventionTasksState } from "./mise.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `readiness` module (ADR-208): how ready each repo is for agents to build, test and run it, as the gaps
 * that stand in their way, each with what it costs an agent. It only reads the cards, the graph and `mise tasks ls`; it
 * changes nothing. Every action is `POST /api/readiness/<action>`.
 */

/**
 * What a gap is: `mise-missing` mise is not installed, `mise-untrusted` the repo's mise config is not trusted,
 * `mise-failed` mise could not list the repo's tasks, `no-build-test` no mise task `build` or `test` that can work here,
 * `no-dev` a Spring Boot app without the mise task `dev` a service needs, `tool-unpinned` a tool version the repo asks for
 * outside its mise config, `unresolved-call` an HTTP client the graph cannot join to a repo, `card-incomplete` a card that
 * missed something, `card-unavailable` a repo without commits or one git could not read, `mise-invalid` a problem `mise tasks
 * validate` or mise's own warnings find in the repo's mise config (a missing dependency, an unknown field), `mise-unformatted`
 * a mise config `mise fmt` would rewrite.
 */
export const ReadinessGapCode = z.enum([
  "mise-missing",
  "mise-untrusted",
  "mise-failed",
  "no-build-test",
  "mise-invalid",
  "no-dev",
  "tool-unpinned",
  "unresolved-call",
  "mise-unformatted",
  "card-incomplete",
  "card-unavailable",
]);
export type ReadinessGapCode = z.infer<typeof ReadinessGapCode>;

/**
 * What a gap costs an agent: `blocks` it cannot build or test the repo, so Verify cannot judge a task there; `weakens` it
 * can, but less surely (no service, a tool version from this computer, a connection it cannot see); `info` worth knowing,
 * not counted.
 */
export const ReadinessLevel = z.enum(["blocks", "weakens", "info"]);
export type ReadinessLevel = z.infer<typeof ReadinessLevel>;

/** The one place a gap gets its level. */
export const READINESS_GAP_LEVEL: Record<ReadinessGapCode, ReadinessLevel> = {
  "mise-missing": "blocks",
  "mise-untrusted": "blocks",
  "mise-failed": "blocks",
  "no-build-test": "blocks",
  "mise-invalid": "weakens",
  "no-dev": "weakens",
  "tool-unpinned": "weakens",
  "unresolved-call": "weakens",
  "mise-unformatted": "info",
  "card-incomplete": "info",
  "card-unavailable": "info",
};

export const ReadinessGap = z.object({
  code: ReadinessGapCode,
  /** What is missing in this repo, in one sentence for a person: `no mise task test`, `java 21 from pom.xml`. */
  message: z.string(),
});
export type ReadinessGap = z.infer<typeof ReadinessGap>;

/** `ready` no gap that blocks or weakens agents; `gaps` only gaps that weaken them; `blocked` at least one that blocks them. */
export const ReadinessState = z.enum(["ready", "gaps", "blocked"]);
export type ReadinessState = z.infer<typeof ReadinessState>;

export const RepoReadiness = z.object({
  repo: RepoId,
  state: ReadinessState,
  /** In `ReadinessGapCode` order, at most one of each code. */
  gaps: z.array(ReadinessGap),
});
export type RepoReadiness = z.infer<typeof RepoReadiness>;

export const ReadinessReport = z.object({
  /** In the order of the repo list. */
  repos: z.array(RepoReadiness),
  /** Whether the convention tasks file is written, so the UI can offer it for `no-build-test`. */
  conventionTasks: ConventionTasksState.shape.state,
  checkedAt: z.string(),
});
export type ReadinessReport = z.infer<typeof ReadinessReport>;

/** The state a repo's gaps add up to. */
export function readinessState(gaps: readonly ReadinessGap[]): ReadinessState {
  const levels = gaps.map((g) => READINESS_GAP_LEVEL[g.code]);
  if (levels.includes("blocks")) return "blocked";
  return levels.includes("weakens") ? "gaps" : "ready";
}

const endpoint = apiEndpoints("readiness");

export const readinessApi = {
  /** Every repo of the projects folder; `mise tasks ls` is asked again only for repos whose commit changed, unless `fresh`. */
  all: endpoint("all", z.object({ fresh: z.boolean().default(false) }).strict(), ReadinessReport),
  /** One repo, always asking mise again. */
  repo: endpoint("repo", z.object({ repo: RepoId }).strict(), RepoReadiness),
};
