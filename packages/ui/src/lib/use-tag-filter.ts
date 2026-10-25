import { cardsApi, type Repo, type RepoTag } from "@trackwall/protocol";
import { useCallback, useMemo, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { hasAllTags, tagCounts, tagsByRepo, toggleTag } from "./repo-tags.ts";
import { useRemote } from "./use-remote.ts";

/**
 * Tags depend on the repo's commits (the card) and on the rules in `workspace.yaml`: a new HEAD in the list fetches them
 * at once, and a manual change of the rules shows up after this time at the latest.
 */
const TAGS_POLL_MS = 60_000;

export interface TagFilterHandle {
  tags: Map<string, RepoTag[]>;
  counts: { name: string; count: number }[];
  selected: string[];
  /** Repo z wszystkimi wybranymi tagami. */
  repos: Repo[];
  toggle: (name: string) => void;
  clear: () => void;
}

/** The tags of the repos in the list (ADR-25) and the filter by them; fetched anew when the set of repos or any HEAD changes. */
export function useTagFilter(conn: Connection, all: readonly Repo[]): TagFilterHandle {
  const [selected, setSelected] = useState<string[]>([]);
  const heads = all.map((r) => `${r.id}@${r.status.kind === "ok" ? (r.status.head?.hash ?? "") : ""}`).join(",");
  const load = useCallback(() => post(conn, cardsApi.tags, {}), [conn]);
  const remote = useRemote(load, { pollMs: TAGS_POLL_MS, refreshKey: heads });
  const tags = useMemo(() => tagsByRepo(remote.data), [remote.data]);
  return {
    tags,
    counts: tagCounts(tags, selected),
    selected,
    repos: all.filter((repo) => hasAllTags(tags.get(repo.id), selected)),
    toggle: (name) => setSelected((current) => toggleTag(current, name)),
    clear: () => setSelected([]),
  };
}
