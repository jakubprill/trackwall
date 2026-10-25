import { cardsApi, type Repo, type RepoTag } from "@trackwall/protocol";
import { useCallback, useMemo, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { REPO_TAGS_PACE } from "./repo-changes.ts";
import { hasAllTags, tagCounts, tagsByRepo, toggleTag } from "./repo-tags.ts";
import { useRemote } from "./use-remote.ts";
import type { RepoChangesHandle } from "./use-repo-changes.ts";

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
export function useTagFilter(conn: Connection, all: readonly Repo[], repoChanges: RepoChangesHandle): TagFilterHandle {
  const [selected, setSelected] = useState<string[]>([]);
  const heads = all.map((r) => `${r.id}@${r.status.kind === "ok" ? (r.status.head?.hash ?? "") : ""}`).join(",");
  const load = useCallback(() => post(conn, cardsApi.tags, {}), [conn]);
  const remote = useRemote(load, { pollMs: () => repoChanges.pollMs(REPO_TAGS_PACE), refreshKey: heads });
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
