import {
  BUILD_MISE_TASK,
  CONVENTION_BUILD_FILES,
  countLabel,
  type MiseConfigCheck,
  type MiseTasks,
  type ReadinessGap,
  ReadinessGapCode,
  type RepoCard,
  SERVICE_MISE_TASK,
  VERIFY_MISE_TASK,
} from "@trackwall/protocol";

/**
 * A repo's gaps for agents (§4.26, ADR-208), from what the daemon already knows: `mise tasks ls`, the card of its commit and
 * the HTTP clients the graph could not join. A pure function, so every rule is in one place and tested on its own.
 */

/** The card as the `cards` module gives it: `null` for a repo without commits, or why git could not read the repo. */
export type CardState = { kind: "ok"; card: RepoCard | null } | { kind: "unavailable"; message: string };

export interface RepoFacts {
  mise: MiseTasks;
  /**
   * mise's check of the repo's own config files; `null` when mise could not read the config, which `mise` then says, or did
   * not answer the check, which is asked again next time.
   */
  config: MiseConfigCheck | null;
  card: CardState;
  /** How many HTTP clients of the repo point to no repo in the list (graph problems, ADR-116). */
  unresolvedCalls: number;
}

export function repoGaps(facts: RepoFacts): ReadinessGap[] {
  const card = facts.card.kind === "ok" ? facts.card.card : null;
  const gaps = [
    ...miseGaps(facts.mise, card),
    ...(facts.config === null ? [] : configGaps(facts.config)),
    ...cardGaps(facts.mise, card),
    ...(facts.unresolvedCalls > 0 ? [unresolvedGap(facts.unresolvedCalls)] : []),
    ...cardStateGaps(facts.card),
  ];
  return gaps.sort((a, b) => CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code));
}

const CODE_ORDER = ReadinessGapCode.options;

function miseGaps(mise: MiseTasks, card: RepoCard | null): ReadinessGap[] {
  if (mise.kind === "not_installed") return [{ code: "mise-missing", message: "mise is not installed, so no mise task can run" }];
  if (mise.kind === "untrusted")
    return [{ code: "mise-untrusted", message: "mise does not run this repo's tasks until you trust its config" }];
  if (mise.kind === "error") return [{ code: "mise-failed", message: firstLine(mise.message) }];
  const missing = [BUILD_MISE_TASK, VERIFY_MISE_TASK].filter((name) => !mise.tasks.some((t) => t.name === name));
  if (missing.length > 0) return [{ code: "no-build-test", message: `no mise task ${missing.join(" or ")}` }];
  // The convention tasks are listed in every repo of the projects folder, but fail where they find no build file.
  const fromConvention = mise.tasks.filter((t) => [BUILD_MISE_TASK, VERIFY_MISE_TASK].includes(t.name) && t.origin === "convention");
  if (fromConvention.length > 0 && card !== null && !hasConventionBuildFile(card)) {
    const names = fromConvention.map((t) => t.name).join(" and ");
    const which = fromConvention.length === 1 ? `the convention task ${names} finds` : `the convention tasks ${names} find`;
    return [{ code: "no-build-test", message: `${which} no build file in the repo root` }];
  }
  return [];
}

/** What mise finds in the config it reads: a problem weakens agents, a file it would format only says so. */
function configGaps(config: MiseConfigCheck): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  const [first, ...rest] = config.problems;
  if (first !== undefined) {
    const more = rest.length === 0 ? "" : ` (and ${countLabel(rest.length, { one: "more problem", other: "more problems" })})`;
    gaps.push({ code: "mise-invalid", message: `${first.message}${more}` });
  }
  if (config.unformatted.length > 0)
    gaps.push({ code: "mise-unformatted", message: `mise fmt would rewrite ${config.unformatted.join(", ")}` });
  return gaps;
}

function hasConventionBuildFile(card: RepoCard): boolean {
  return card.buildFiles.some((f) => CONVENTION_BUILD_FILES.some((name) => name === f.path));
}

/** Gaps only the card shows: they need to know what the repo is, so a repo without a card has none of them. */
function cardGaps(mise: MiseTasks, card: RepoCard | null): ReadinessGap[] {
  if (card === null) return [];
  const gaps: ReadinessGap[] = [];
  const apps = card.provides.flatMap((p) => (p.kind === "app" ? [p.name] : []));
  // Without a list from mise it is unknown whether `dev` is there; the mise gap already says why.
  if (apps.length > 0 && mise.kind === "ok" && !mise.tasks.some((t) => t.name === SERVICE_MISE_TASK))
    gaps.push({ code: "no-dev", message: `${apps.join(", ")} cannot start as a service: no mise task ${SERVICE_MISE_TASK}` });
  const unpinned = unpinnedTools(card);
  if (unpinned.length > 0) gaps.push({ code: "tool-unpinned", message: `not pinned in mise: ${unpinned.join(", ")}` });
  if (card.problems.length > 0) gaps.push({ code: "card-incomplete", message: card.problems.map((p) => p.message).join("; ") });
  return gaps;
}

/** Tools the repo asks for only outside its mise config (`java 21 from pom.xml`): the build then takes this computer's version. */
function unpinnedTools(card: RepoCard): string[] {
  const pinned = new Set(card.tools.filter((t) => t.source === "mise").map((t) => t.tool));
  const hinted = new Map<string, string>();
  for (const t of card.tools) {
    if (t.source === "hint" && !pinned.has(t.tool) && !hinted.has(t.tool))
      hinted.set(t.tool, `${t.tool} ${t.version} from ${t.evidence.path}`);
  }
  return [...hinted.values()];
}

function unresolvedGap(count: number): ReadinessGap {
  return {
    code: "unresolved-call",
    message: `${countLabel(count, { one: "HTTP client", other: "HTTP clients" })} without a repo to call in the list`,
  };
}

function cardStateGaps(card: CardState): ReadinessGap[] {
  if (card.kind === "unavailable") return [{ code: "card-unavailable", message: firstLine(card.message) }];
  return card.card === null ? [{ code: "card-unavailable", message: "the repo has no commits yet, so it has no card" }] : [];
}

/** mise's and git's messages can run over many lines; a gap is one sentence, and the repo's tab has the rest. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
