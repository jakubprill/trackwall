import {
  CHANGE_PART_NOTE_MAX,
  type ChangePart,
  countLabel,
  READINESS_GAP_LEVEL,
  type ReadinessGapCode,
  ReadinessGapCode as ReadinessGapCodes,
  type ReadinessLevel,
  type ReadinessReport,
  type ReadinessState,
  type RepoReadiness,
  TASK_TITLE_MAX,
} from "@trackwall/protocol";

/**
 * Agent readiness in "Overview" and on a repo's card (ADR-201): the gaps of the repos grouped by what they cost an agent,
 * each with its words for a person and the one fix the view offers for it, and the prompt of a task that closes it.
 */

/** A gap in words: what is missing, and why it matters to an agent. */
const GAP_LABELS: Record<ReadinessGapCode, { title: string; why: string }> = {
  "mise-missing": { title: "mise is not installed", why: "Agents run builds and tests as mise tasks." },
  "mise-untrusted": { title: "mise config not trusted", why: "Agents cannot run any mise task here until you trust it." },
  "mise-failed": { title: "mise cannot list the tasks", why: "Agents cannot run any mise task here." },
  "no-build-test": { title: "No build or test task", why: "Verify and agents cannot build or test these repos." },
  "no-dev": { title: "Spring Boot app without a dev task", why: "It cannot start as a service, for you or for an agent." },
  "tool-unpinned": { title: "Tool versions not pinned in mise", why: "The build uses whatever version this computer has." },
  "unresolved-call": { title: "HTTP calls without a target", why: "The graph cannot tell an external service from a missing link." },
  "card-incomplete": { title: "Card incomplete", why: "Agents read the card instead of the build files." },
  "card-unavailable": { title: "No card yet", why: "Gaps that need the card are not checked." },
};

export function gapTitle(code: ReadinessGapCode): string {
  return GAP_LABELS[code].title;
}

export function gapWhy(code: ReadinessGapCode): string {
  return GAP_LABELS[code].why;
}

export const LEVEL_LABELS: Record<ReadinessLevel, string> = {
  blocks: "Blocks agents",
  weakens: "Weakens agents",
  info: "Good to know, not counted",
};

/**
 * What the view offers for a gap: `convention` writes the convention tasks file, `agent` a task with a prompt to read,
 * `repo` opens the repo, where its mise tasks tab trusts the config after showing it (ADR-157), `graph` selects the repo
 * on the graph, whose panel lists its calls without a target, `none` nothing to click (install mise, wait for the card).
 */
export type GapFix = "convention" | "agent" | "repo" | "graph" | "none";

export function gapFix(code: ReadinessGapCode, conventionTasks: ReadinessReport["conventionTasks"]): GapFix {
  switch (code) {
    case "no-build-test":
      // The convention tasks file covers every Maven, Gradle and npm repo; once it is there, the repos left need their own tasks.
      return conventionTasks === "absent" ? "convention" : "agent";
    case "no-dev":
    case "tool-unpinned":
      return "agent";
    case "mise-untrusted":
    case "mise-failed":
    case "card-incomplete":
      return "repo";
    case "unresolved-call":
      return "graph";
    case "mise-missing":
    case "card-unavailable":
      return "none";
  }
}

/** The repos one gap is in, each with its own reason. */
export interface GapGroup {
  code: ReadinessGapCode;
  repos: { repo: string; message: string }[];
}

/** The gaps of every repo, one group per gap, under the levels in order; empty levels and gaps are left out. */
export function readinessGroups(repos: readonly RepoReadiness[]): { level: ReadinessLevel; gaps: GapGroup[] }[] {
  const byCode = new Map<ReadinessGapCode, GapGroup>();
  for (const r of repos) {
    for (const g of r.gaps) {
      const group = byCode.get(g.code) ?? { code: g.code, repos: [] };
      group.repos.push({ repo: r.repo, message: g.message });
      byCode.set(g.code, group);
    }
  }
  const levels: ReadinessLevel[] = ["blocks", "weakens", "info"];
  return levels
    .map((level) => ({
      level,
      gaps: ReadinessGapCodes.options.flatMap((code) => {
        const group = byCode.get(code);
        return group && READINESS_GAP_LEVEL[code] === level ? [group] : [];
      }),
    }))
    .filter((l) => l.gaps.length > 0);
}

/** How many repos are in each state. */
export function readinessCounts(repos: readonly RepoReadiness[]): Record<ReadinessState, number> {
  const counts: Record<ReadinessState, number> = { ready: 0, gaps: 0, blocked: 0 };
  for (const r of repos) counts[r.state]++;
  return counts;
}

/** What a task closing a gap is asked; each part's note says what its repo lacks. */
const AGENT_PROMPTS: Partial<Record<ReadinessGapCode, string>> = {
  "no-build-test":
    "Add the mise tasks build and test to this repo's mise.toml, so that agents and Verify can build it and run its tests. Use the repo's own build tool and wrapper, keep build without tests, and run both tasks to show they pass.",
  "no-dev":
    "Add a mise task dev to this repo's mise.toml that starts its Spring Boot app locally on the port its configuration gives, so that it can start as a service. Do not change the app itself. Start the task once to show the app comes up.",
  "tool-unpinned":
    "Pin the tool versions this repo needs in its mise.toml [tools], taking each version from where the build already asks for it, so that every machine and agent builds with the same versions. Do not change the versions themselves. Run the build to show it still passes.",
};

export function gapPrompt(code: ReadinessGapCode): string {
  return AGENT_PROMPTS[code] ?? `Close this gap in the repo: ${gapTitle(code)}.`;
}

/** The change's title, which also names its branch: `Readiness: No build or test task`. */
export function gapTaskTitle(code: ReadinessGapCode): string {
  return `Readiness: ${gapTitle(code)}`.slice(0, TASK_TITLE_MAX);
}

/** A repo's part: the prompt ends with `In orders-api: no mise task test`, the gap as Trackwall found it there. */
export function gapPart(repo: { repo: string; message: string }): ChangePart {
  return { repo: repo.repo, note: repo.message.slice(0, CHANGE_PART_NOTE_MAX) };
}

/**
 * What a repo's card offers for one of its gaps: `mise` opens its mise tasks tab, which trusts the config after showing
 * it and offers the convention tasks (ADR-157); `agent` a task with a prompt to read; `none` the Overview or the doctor
 * has the rest.
 */
export function repoGapFix(code: ReadinessGapCode): "mise" | "agent" | "none" {
  if (code === "no-build-test" || code === "mise-untrusted" || code === "mise-failed") return "mise";
  return code === "no-dev" || code === "tool-unpinned" ? "agent" : "none";
}

/** The card's one line: `ready`, `2 gaps`, `blocked: no build or test task`. */
export function readinessLine(readiness: RepoReadiness): string {
  const counted = readiness.gaps.filter((g) => READINESS_GAP_LEVEL[g.code] !== "info");
  if (readiness.state === "ready") return "ready";
  if (readiness.state === "blocked") {
    const first = counted.find((g) => READINESS_GAP_LEVEL[g.code] === "blocks");
    return first ? `blocked: ${gapTitle(first.code).toLowerCase()}` : "blocked";
  }
  return countLabel(counted.length, { one: "gap", other: "gaps" });
}
