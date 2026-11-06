import { type KnowledgeList, type KnowledgeListEntry, knowledgeApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { shownEntry } from "./knowledge.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

const KNOWLEDGE_POLL_MS = 10_000;

/**
 * The workspace knowledge of Plan (ADR-170, ADR-216), read while Plan is open, since its left column counts the entries
 * to approve; a proposal an agent writes shows within the poll. `entry` is the one the right column shows while the
 * knowledge is the place shown.
 */
export function useKnowledge(
  conn: Connection,
  shown: boolean,
): {
  knowledge: RemoteHandle<KnowledgeList>;
  entries: readonly KnowledgeListEntry[];
  entry: KnowledgeListEntry | undefined;
  select: (name: string | undefined) => void;
} {
  const load = useCallback(() => post(conn, knowledgeApi.list, {}), [conn]);
  const knowledge = useRemote(load, { pollMs: KNOWLEDGE_POLL_MS });
  const [selected, select] = useState<string>();
  const entries = knowledge.data?.entries ?? [];
  return { knowledge, entries, entry: shown ? shownEntry(entries, selected) : undefined, select };
}
