import { cardsApi, type Repo, type RepoTag } from "@trackwall/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { hasAllTags, tagCounts, tagsByRepo, toggleTag } from "./repo-tags.ts";
import { REPO_TAGS_PACE } from "./repo-watch.ts";
import { useRemote } from "./use-remote.ts";
import type { RepoWatchHandle } from "./use-repo-watch.ts";

export interface TagFilterHandle {
  tags: Map<string, RepoTag[]>;
  counts: { name: string; count: number }[];
  selected: string[];
  /** Repos with all the selected tags. */
  repos: Repo[];
  toggle: (name: string) => void;
  clear: () => void;
}

/**
 * The tags of the repos in the list (ADR-25) and the filter by them. Tags depend on the repos' commits (the card) and on
 * the rules in `workspace.yaml`: they are fetched anew when the set of repos or any HEAD in the list changes, and a hand
 * change of the rules shows up after the poll interval at the latest (`REPO_TAGS_PACE`).
 */
export function useTagFilter(conn: Connection, all: readonly Repo[], repoWatch: RepoWatchHandle): TagFilterHandle {
  const [selected, setSelected] = useState<string[]>([]);
  const [heads, setHeads] = useState("");
  // While statuses come in batches (ADR-113), every batch would change the key and read the cards again: wait for the last.
  useEffect(() => {
    if (!all.some((r) => r.status.kind === "loading")) setHeads(headsKey(all));
  }, [all]);
  const load = useCallback(() => post(conn, cardsApi.tags, {}), [conn]);
  const remote = useRemote(load, { ...repoWatch.options(REPO_TAGS_PACE), refreshKey: heads });
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

/** Changes when the set of repos or any HEAD in it changes. */
function headsKey(repos: readonly Repo[]): string {
  return repos.map((r) => `${r.id}@${r.status.kind === "ok" ? (r.status.head?.hash ?? "") : ""}`).join(",");
}
