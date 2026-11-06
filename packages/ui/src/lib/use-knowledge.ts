import { type KnowledgeList, type KnowledgeListEntry, knowledgeApi } from "@trackwall/protocol";
import { useCallback, useEffect, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type KnowledgeFilter, NO_KNOWLEDGE_FILTER, shownEntry } from "./knowledge.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

/** Every 10 s while the knowledge is the place shown; once a minute elsewhere in Plan, for the count on the left. */
const SHOWN_POLL_MS = 10_000;
const COUNT_POLL_MS = 60_000;

/**
 * The workspace knowledge of Plan (ADR-170, ADR-216), read while Plan is open, since its left column counts the entries
 * to approve; a proposal an agent writes shows within the poll. `entry` is the one the right column shows while the
 * knowledge is the place shown. Once shown, an entry stays selected: an approval, or a new proposal that sorts before
 * it, never puts another entry under the user's next click.
 */
export function useKnowledge(
  conn: Connection,
  shown: boolean,
): {
  knowledge: RemoteHandle<KnowledgeList>;
  entries: readonly KnowledgeListEntry[];
  entry: KnowledgeListEntry | undefined;
  select: (name: string | undefined) => void;
  filter: KnowledgeFilter;
  setFilter: (filter: KnowledgeFilter) => void;
} {
  const load = useCallback(() => post(conn, knowledgeApi.list, {}), [conn]);
  const knowledge = useRemote(load, { pollMs: () => (shown ? SHOWN_POLL_MS : COUNT_POLL_MS) });
  const [selected, select] = useState<string>();
  const [filter, setFilter] = useState(NO_KNOWLEDGE_FILTER);
  const entries = knowledge.data?.entries ?? [];
  const entry = shown ? shownEntry(entries, selected) : undefined;
  useEffect(() => {
    if (entry && entry.name !== selected) select(entry.name);
  }, [entry, selected]);
  return { knowledge, entries, entry, select, filter, setFilter };
}
