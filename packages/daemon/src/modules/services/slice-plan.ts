import { type GraphEdge, MAX_SLICE_REPOS } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * Which services a start brings up and in what order (§4.3, ADR-45): the repo asked for and every repo it calls at
 * runtime, transitively. Runtime means `http` and `manual` edges of the graph; `package` edges matter only for the
 * build, and `low` edges (paths that match endpoints of several repos) are too uncertain to start a process for.
 * Dependencies start in waves: a repo starts once every repo it calls within the slice has settled, so a config
 * server or a registry comes up before its clients. Repos in a cycle start together in the last wave.
 */

export interface SlicePlan {
  /** Waves in start order; the repo asked for is in the last one. */
  waves: string[][];
  /** For each repo, the repos in the slice that call it and the edge key (app name, address, note). */
  calledBy: Map<string, { repo: string; key: string }[]>;
}

function isRuntimeEdge(edge: GraphEdge): boolean {
  return edge.kind !== "package" && edge.confidence !== "low" && edge.from !== edge.to;
}

export function planSlice(edges: readonly GraphEdge[], root: string): SlicePlan {
  const runtime = edges.filter(isRuntimeEdge);
  const calls = new Map<string, Set<string>>();
  const calledBy = new Map<string, { repo: string; key: string }[]>([[root, []]]);
  const queue = [root];
  for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
    const targets = new Set<string>();
    for (const edge of runtime.filter((e) => e.from === repo)) {
      targets.add(edge.to);
      const callers = calledBy.get(edge.to) ?? [];
      if (!callers.some((c) => c.repo === repo && c.key === edge.key)) callers.push({ repo, key: edge.key });
      if (!calledBy.has(edge.to)) queue.push(edge.to);
      calledBy.set(edge.to, callers);
    }
    calls.set(repo, targets);
  }
  if (calledBy.size > MAX_SLICE_REPOS) {
    throw new DomainError(
      "bad_request",
      `${root} with its dependencies is ${calledBy.size} repos, more than ${MAX_SLICE_REPOS}; start it without dependencies and start the ones you need one by one`,
    );
  }
  return { waves: waves(calls), calledBy };
}

/** Repos whose callees have all started go first; whatever is left in a cycle goes together. */
function waves(calls: Map<string, Set<string>>): string[][] {
  const result: string[][] = [];
  const done = new Set<string>();
  while (done.size < calls.size) {
    const ready = [...calls.keys()].filter((repo) => !done.has(repo) && [...(calls.get(repo) ?? [])].every((t) => done.has(t)));
    const wave = ready.length > 0 ? ready : [...calls.keys()].filter((repo) => !done.has(repo));
    for (const repo of wave) done.add(repo);
    result.push(wave);
  }
  return result;
}
