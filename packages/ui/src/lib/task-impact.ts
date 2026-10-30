import { type ChangedEndpoint, type ChangedEndpoints, countLabel, type ImpactedRepo, mcpTools } from "@trackwall/protocol";
import type { EdgePair } from "./graph-layout.ts";

/**
 * The logic of a task's Impact tab and of the impact on the Overview graph (ADR-147): where each repo the change reaches
 * sits in the drawing, what the summary says and the prompt a hand-off to a reached repo starts with. Without React.
 */

/** The stroke of each ring, from the task's repo outwards: the accent, then state colours fading with the distance. */
export const IMPACT_RING_STROKE = ["stroke-primary", "stroke-destructive", "stroke-warning", "stroke-warning/60"] as const;

/** How far a repo is from the change: 0 for the task's own repo, then its ring. */
export function impactRings(changed: Pick<ChangedEndpoints, "repo" | "impact">): Map<string, number> {
  return new Map([[changed.repo, 0], ...changed.impact.map((r) => [r.repo, r.ring] as const)]);
}

/** One line over the tab: how many endpoints changed and how many repos the change reaches, sure or maybe. */
export function impactSummary({ endpoints, impact, truncated }: Pick<ChangedEndpoints, "endpoints" | "impact" | "truncated">): string {
  if (endpoints.length === 0) return "The task's commits change no endpoint.";
  const changed = `${countLabel(endpoints.length, { one: "endpoint", other: "endpoints" })}${truncated ? " (more not shown)" : ""} changed`;
  if (impact.length === 0) return `${changed}; no other repo calls them.`;
  const maybe = impact.filter((r) => !r.sure).length;
  const reached = countLabel(impact.length - maybe, { one: "repo", other: "repos" });
  return `${changed}, reaching ${reached}${maybe > 0 ? ` and maybe ${maybe} more` : ""}.`;
}

/** The changed endpoints a repo of ring 1 calls, each with that repo's calls of it. */
export function endpointsCalledBy(endpoints: readonly ChangedEndpoint[], repo: string): ChangedEndpoint[] {
  return endpoints.flatMap((e) => {
    const callers = e.callers.filter((c) => c.repo === repo);
    return callers.length === 0 ? [] : [{ ...e, callers }];
  });
}

/**
 * The prompt of a task handed on to a reached repo, for the user to edit before the start: the endpoints and calls
 * from the daemon's comparison, and the tools that read the handing task's change (the new task's instructions name it).
 */
export function handoffPrompt(changed: Pick<ChangedEndpoints, "repo" | "endpoints">, taskName: string, reached: ImpactedRepo): string {
  const from = `the task “${taskName}” in ${changed.repo}`;
  const read = `Read that task's change with ${mcpTools.getChangedEndpoints.name} and ${mcpTools.getTaskChanges.name} before you change code.`;
  if (reached.ring === 1) {
    const lines = endpointsCalledBy(changed.endpoints, reached.repo).map(endpointLine);
    return [
      `The task “${taskName}” in ${changed.repo} changes endpoints that ${reached.repo} calls:`,
      ...lines,
      "",
      `Update ${reached.repo} to the new contract. ${read}`,
    ].join("\n");
  }
  const via =
    reached.calls.length > 0 ? reached.calls.map((c) => `${c.method ?? "ANY"} ${c.path} of ${c.repo}`).join(", ") : reached.uses.join(", ");
  return [
    `${reached.repo} calls ${via}, which ${from} may reach through its changed endpoints.`,
    "",
    `Check whether the change reaches ${reached.repo}, and update it if it does. ${read}`,
  ].join("\n");
}

function endpointLine(e: ChangedEndpoint): string {
  const contract = e.after === null ? "" : contractText(e.after);
  const dtos = e.dtos.length > 0 ? `; DTOs changed: ${e.dtos.join(", ")}` : "";
  const calls = e.callers.map((c) => `${c.client} at ${c.evidence.path}:${c.evidence.line}`).join(", ");
  return `- ${e.change} ${e.method ?? "ANY"} ${e.path}${contract}${dtos}, called by ${calls}`;
}

function contractText({ request, response }: { request: string | null; response: string | null }): string {
  const parts = [request && `request ${request}`, response && `response ${response}`].filter((p) => p !== null);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
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
