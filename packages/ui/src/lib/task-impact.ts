import { type ChangedEndpoints, countLabel, type ImpactedRepo, type TaskProposal } from "@trackwall/protocol";
import type { EdgePair } from "./graph-layout.ts";

/**
 * The logic of a task's Impact tab and of the impact on the Overview graph (ADR-147, ADR-201): where each repo the change reaches
 * sits in the drawing and what the summary says; the prompt of a hand-off is `handoffPrompt` in `protocol`. Without React.
 */

/**
 * A task's impact is read again this often while it is shown: a new commit's card is read once and cached (ADR-25),
 * so a later read is a HEAD and two cache hits, and ten seconds keeps up with the agent's commits.
 */
export const IMPACT_POLL_MS = 10_000;

/**
 * The look of each ring, from the task's repo outwards: the accent, then state colours fading with the distance; a
 * stroke for the drawings' lines and a border with its glow for the Overview's repo cards.
 */
export const IMPACT_RING_STROKE = ["stroke-primary", "stroke-destructive", "stroke-warning", "stroke-warning/60"] as const;
export const IMPACT_RING_BORDER = [
  "border-primary shadow-glow-primary",
  "border-destructive shadow-glow-destructive",
  "border-warning shadow-glow-warning",
  "border-warning/60",
] as const;

/** Why a repo is only maybe reached, for its tooltip. */
export const MAYBE_REACHED =
  "Maybe reached: it is reached only through a repo whose code Trackwall could not follow, or through a client that knows an address but no paths";

/** How far a repo is from the change: 0 for the task's own repo, then its ring. */
export function impactRings(changed: Pick<ChangedEndpoints, "repo" | "impact">): Map<string, number> {
  return new Map([[changed.repo, 0], ...changed.impact.map((r) => [r.repo, r.ring] as const)]);
}

/**
 * One line over the tab: how many endpoints and public library types changed and how many repos the change reaches,
 * sure or maybe.
 */
export function impactSummary({
  endpoints,
  types,
  impact,
  truncated,
}: Pick<ChangedEndpoints, "endpoints" | "types" | "impact" | "truncated">): string {
  if (endpoints.length === 0 && types.length === 0) return "The task's commits change no endpoint.";
  const counted = [
    endpoints.length > 0 && countLabel(endpoints.length, { one: "endpoint", other: "endpoints" }),
    types.length > 0 && countLabel(types.length, { one: "public type", other: "public types" }),
  ].filter((c) => c !== false);
  const changed = `${counted.join(" and ")}${truncated ? " (more not shown)" : ""} changed`;
  if (impact.length === 0) return `${changed}; no other repo ${types.length === 0 ? "calls" : "uses"} them.`;
  const maybe = impact.filter((r) => !r.sure).length;
  const reached = countLabel(impact.length - maybe, { one: "repo", other: "repos" });
  return `${changed}, reaching ${reached}${maybe > 0 ? ` and maybe ${maybe} more` : ""}.`;
}

/**
 * Why Trackwall itself proposed a task (ADR-198, ADR-201), under the proposal's title: the proposal's prompt came from
 * comparing the task's commits, not from its agent. `null` for any other proposal.
 */
export function impactProposalNote(proposal: Pick<TaskProposal, "repo" | "fromImpact">): string | null {
  return proposal.fromImpact ? `Proposed by Trackwall: ${proposal.repo} uses endpoints or public types this task's commits changed` : null;
}

/**
 * The ring of the calling repo when an Overview edge carries a task's change from one ring to the next (its `calls`
 * edges, from a repo of ring n to one of ring n − 1), else `undefined`.
 */
export function impactEdgeRing(
  pair: Pick<EdgePair, "from" | "to" | "edges">,
  rings: ReadonlyMap<string, number> | undefined,
): number | undefined {
  const from = rings?.get(pair.from);
  const to = rings?.get(pair.to);
  return from !== undefined && to !== undefined && from === to + 1 && pair.edges.some((e) => e.kind === "calls") ? from : undefined;
}

/** Where a node sits in the Impact tab's rings, in the drawing's units, the task's repo at the centre. */
export interface ImpactPoint {
  repo: string;
  ring: number;
  x: number;
  y: number;
}

/** The radius of ring 1; each further ring is as far again. */
export const RING_GAP = 110;

/**
 * The rings of the drawing: a ring's repos evenly round its circle, in the order of the angles of the repos they use,
 * so that a repo sits near what it calls and the lines between rings cross less. Ring 1 starts at the top.
 */
export function impactPoints(repo: string, impact: readonly ImpactedRepo[]): ImpactPoint[] {
  const points: ImpactPoint[] = [{ repo, ring: 0, x: 0, y: 0 }];
  const angles = new Map([[repo, -Math.PI / 2]]);
  const rings = [...new Set(impact.map((r) => r.ring))].sort((a, b) => a - b);
  for (const ring of rings) {
    const ordered = impact
      .filter((r) => r.ring === ring)
      .map((r) => ({ repo: r.repo, wanted: meanAngle(r.uses.map((u) => angles.get(u) ?? 0)) }))
      .sort((a, b) => a.wanted - b.wanted || a.repo.localeCompare(b.repo));
    const step = (2 * Math.PI) / ordered.length;
    // The ring turns so that its first repo is where it wants to be; the rest follow round.
    const start = ordered[0]?.wanted ?? 0;
    ordered.forEach(({ repo: r }, i) => {
      const angle = start + i * step;
      angles.set(r, angle);
      points.push({ repo: r, ring, x: Math.cos(angle) * RING_GAP * ring, y: Math.sin(angle) * RING_GAP * ring });
    });
  }
  return points;
}

function meanAngle(angles: readonly number[]): number {
  const x = angles.reduce((sum, a) => sum + Math.cos(a), 0);
  const y = angles.reduce((sum, a) => sum + Math.sin(a), 0);
  return Math.atan2(y, x);
}
