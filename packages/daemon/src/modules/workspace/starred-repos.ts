import { MAX_STARRED_REPOS, type StarredRepos } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * The starred repos after starring or unstarring one (ADR-192): a new star goes to the end, so the list keeps the order
 * the user starred in, and starring a starred repo or unstarring one that is not starred changes nothing.
 */
export function withStar(ids: StarredRepos, repo: string, starred: boolean): StarredRepos {
  if (ids.includes(repo) === starred) return ids;
  if (!starred) return ids.filter((id) => id !== repo);
  if (ids.length >= MAX_STARRED_REPOS)
    throw new DomainError("bad_request", `you can star at most ${MAX_STARRED_REPOS} repos; unstar some first`);
  return [...ids, repo];
}
