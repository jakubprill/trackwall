import type { EdgeEvidence, GraphEdge, GraphNode, GraphProblem, Subgraph, WhoCallsResult } from "@trackwall/protocol";
import { countLabel, evidenceLabel } from "@trackwall/protocol";

const CONNECTIONS = { one: "connection", other: "connections" };
const REPOS = { one: "repo", other: "repos" };
const PACKAGES = { one: "package", other: "packages" };
const ENDPOINTS = { one: "endpoint", other: "endpoints" };

/**
 * The text of the `who_calls` and `subgraph_for` results, which is all the model behind Copilot CLI reads of them
 * (ADR-187): one line per connection, `<from> -> <to>: <kind> by <source> <key> (<confidence>)`, and its evidence
 * indented under it as `from|to <path>:<line>: <detail>` (the repo on that side of the connection), instead of JSON
 * that repeats every field name for every piece of evidence. Evidence from `workspace.yaml` has no side and a full path.
 */
export function whoCallsText(result: WhoCallsResult): string {
  if (result.edges.length === 0) return `No repo uses ${result.repo}.`;
  return [`${countLabel(result.edges.length, CONNECTIONS)} into ${result.repo}:`, ...result.edges.flatMap(edgeLines)].join("\n");
}

export function subgraphText(result: Subgraph): string {
  const lines = [
    `Subgraph of ${result.repo}, depth ${result.depth}: ${countLabel(result.nodes.length, REPOS)}, ${countLabel(result.edges.length, CONNECTIONS)}.`,
    "## Repos",
    ...result.nodes.map(nodeLine),
  ];
  if (result.edges.length > 0) lines.push("## Connections", ...result.edges.flatMap(edgeLines));
  if (result.problems.length > 0) lines.push("## Problems", ...result.problems.map(problemLine));
  return lines.join("\n");
}

function edgeLines(edge: GraphEdge): string[] {
  return [
    `${edge.from} -> ${edge.to}: ${edge.kind} by ${edge.source} ${edge.key} (${edge.confidence})`,
    ...edge.evidence.map((evidence) => `  ${evidenceSide(edge, evidence)}${evidenceLabel(evidence)}: ${evidence.detail}`),
  ];
}

/** Evidence names its repo by the side of the connection, which is shorter than the repo's name in every line. */
function evidenceSide(edge: GraphEdge, evidence: EdgeEvidence): string {
  if (evidence.repo === null) return "";
  if (evidence.repo === edge.from) return "from ";
  if (evidence.repo === edge.to) return "to ";
  return `${evidence.repo} `;
}

/** A node without a card shows only why; counts of a node with one are left out when they are zero. */
function nodeLine(node: GraphNode): string {
  const facts = [
    node.remote === null ? undefined : `remote ${node.remote}`,
    node.tags.length > 0 ? `tags ${node.tags.join(", ")}` : undefined,
    node.apps.length > 0 ? `apps ${node.apps.join(", ")}` : undefined,
    node.provides ? countLabel(node.provides, PACKAGES) : undefined,
    node.endpoints ? countLabel(node.endpoints, ENDPOINTS) : undefined,
    node.problem === null ? undefined : `no card: ${node.problem}`,
  ].filter((fact) => fact !== undefined);
  return facts.length === 0 ? node.repo : `${node.repo}: ${facts.join("; ")}`;
}

function problemLine(problem: GraphProblem): string {
  return `${problem.code} in ${problem.repo} ${evidenceLabel(problem.evidence)} (${problem.via} ${problem.client}): ${problem.message}`;
}
