import { graphApi, knowledgeApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "@/lib/api";
import { orderHints, orderRelations } from "@/lib/change-order";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * What Trackwall knows about the merge order of a change's repos (ADR-172), under the repos where the user sets it: the
 * connection graph's edges that go against the order, and the workspace knowledge about links between them. Hints only,
 * so a graph or knowledge list that cannot be read shows nothing rather than an error in the way of the change.
 */
export function ChangeOrderHints({ conn, repos }: { conn: Connection; repos: readonly string[] }) {
  const loadGraph = useCallback(() => post(conn, graphApi.graph, {}), [conn]);
  const graph = useRemote(loadGraph);
  const loadKnowledge = useCallback(() => post(conn, knowledgeApi.list, {}), [conn]);
  const knowledge = useRemote(loadKnowledge);
  const hints = orderHints(repos, graph.data?.edges ?? []);
  const relations = orderRelations(repos, knowledge.data?.entries ?? []);
  if (hints.length === 0 && relations.length === 0) return null;
  return (
    <section aria-label="Merge order hints" className="text-muted-foreground flex max-w-prose flex-col gap-1 text-xs">
      {hints.map((hint) => (
        <p key={`${hint.user}:${hint.used}`}>{`Connection graph: ${hint.text}`}</p>
      ))}
      {relations.map((entry) => (
        <p key={entry.name} className="whitespace-pre-wrap">{`Workspace knowledge (${entry.repos.join(", ")}): ${entry.text}`}</p>
      ))}
    </section>
  );
}
