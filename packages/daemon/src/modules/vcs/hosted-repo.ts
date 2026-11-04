import { type HostedRepo, MAX_REMOTE_REPO_PAGES, RemoteRepoName, type RemoteRepoSearch } from "@trackwall/protocol";
import { z } from "zod";

/**
 * How GitHub and GitLab differ as repo hosts (§4.5, ADR-19, ADR-201): the list API path, what each searches and filters
 * itself, response fields and the `gh` / `glab` environment variables. Running the programs, paging and filtering by the
 * query text are in `hosting.ts`.
 */

/** A search without `pages`: what one page of the list depends on. */
export type HostedRepoFilter = Omit<RemoteRepoSearch, "pages">;

export interface HostingApi {
  /** How many pages to fetch for a search that asks for `requested` pages. */
  pages(requested: number): number;
  /** The most pages it ever fetches; a full last page below it is a `next-page`, at it a `narrow`. */
  maxPages: number;
  /** Whether the repo host itself searches repos by `query`; otherwise the daemon filters the fetched pages. */
  searchesOnServer(query: string): boolean;
  /** The `<cli> api` path for one page of repos; `query` in `filter` only when `searchesOnServer`. */
  reposPage(page: number, pageSize: number, filter: HostedRepoFilter): string;
  /**
   * A page of the API response without archived repos and without those the repo host did not filter out by `filter`
   * itself; `received` is the number of repos on the page before filtering.
   */
  parseReposPage(json: unknown, filter: HostedRepoFilter): { items: HostedRepo[]; received: number };
  /** Environment variables: the repo host for `repo clone`, and turning off prompts, colours and update checks. */
  env(host: string): NodeJS.ProcessEnv;
}

/**
 * Names that cannot be passed safely to `gh` or `glab` (outside `RemoteRepoName`) do not get onto the list:
 * GitHub and GitLab do not create such names, so it is at most a response that does not match the documentation.
 */
function page(all: HostedRepo[], received: number): { items: HostedRepo[]; received: number } {
  return { items: all.filter((r) => RemoteRepoName.safeParse(r.fullName).success), received };
}

function sameWord(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const GitHubRepos = z.array(
  z.object({
    full_name: z.string(),
    description: z.string().nullable(),
    html_url: z.string(),
    pushed_at: z.string().nullable(),
    archived: z.boolean(),
    language: z.string().nullable().optional(),
    topics: z.array(z.string()).optional(),
  }),
);

/**
 * `gh api user/repos`: own repos, collaborator repos and repos of organisations the user belongs to, by name; with
 * `starredOnHost`, `user/starred`. This API has no search or filters, so the daemon fetches up to 1000 repos and filters
 * them itself, also by topic and language; that is enough for OSS repos. `scope` changes nothing: GitHub has no list of
 * every repo the user can see.
 */
export const githubApi: HostingApi = {
  pages: () => MAX_REMOTE_REPO_PAGES,
  maxPages: MAX_REMOTE_REPO_PAGES,
  searchesOnServer: () => false,
  reposPage: (page, pageSize, filter) =>
    filter.starredOnHost
      ? `user/starred?sort=updated&per_page=${pageSize}&page=${page}`
      : `user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=${pageSize}&page=${page}`,
  parseReposPage: (json, filter) => {
    const all = GitHubRepos.parse(json);
    const kept = all.filter(
      (r) =>
        !r.archived &&
        (filter.topic === "" || (r.topics ?? []).some((t) => sameWord(t, filter.topic))) &&
        (filter.language === "" || sameWord(r.language ?? "", filter.language)),
    );
    return page(
      kept.map((r) => ({
        fullName: r.full_name,
        description: r.description || null,
        webUrl: r.html_url,
        updatedAt: r.pushed_at,
        topics: r.topics ?? [],
      })),
      all.length,
    );
  },
  env: (host) => ({ GH_HOST: host, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" }),
};

const GitLabProjects = z.array(
  z.object({
    path_with_namespace: z.string(),
    description: z.string().nullable(),
    web_url: z.string(),
    last_activity_at: z.string().nullable(),
    topics: z.array(z.string()).optional(),
  }),
);

/** GitLab matches name fragments only from 3 characters; the daemon matches a shorter query itself on the fetched pages. */
const GITLAB_MIN_SEARCH = 3;

/**
 * `glab api projects`: with the `member` scope projects the user is a member of (also through a group), with `visible`
 * every project the user can see; most recently changed first. A large self-hosted instance has thousands of them, so
 * one page at a time ("Show more"), and GitLab itself searches by name and path with the group (`search_namespaces`)
 * and filters by topic, language and the user's stars.
 */
export const gitlabApi: HostingApi = {
  pages: (requested) => Math.min(requested, MAX_REMOTE_REPO_PAGES),
  maxPages: MAX_REMOTE_REPO_PAGES,
  searchesOnServer: (query) => query.length >= GITLAB_MIN_SEARCH,
  reposPage: (page, pageSize, filter) => {
    const params = new URLSearchParams({
      archived: "false",
      simple: "true",
      order_by: "last_activity_at",
      sort: "desc",
      per_page: String(pageSize),
      page: String(page),
    });
    if (filter.scope === "member") params.set("membership", "true");
    if (filter.starredOnHost) params.set("starred", "true");
    if (filter.topic !== "") params.set("topic", filter.topic);
    if (filter.language !== "") params.set("with_programming_language", filter.language);
    if (filter.query !== "") {
      params.set("search", filter.query);
      params.set("search_namespaces", "true");
    }
    return `projects?${params.toString().replaceAll("+", "%20")}`;
  },
  parseReposPage: (json) => {
    const all = GitLabProjects.parse(json);
    return page(
      all.map((p) => ({
        fullName: p.path_with_namespace,
        description: p.description || null,
        webUrl: p.web_url,
        updatedAt: p.last_activity_at,
        topics: p.topics ?? [],
      })),
      all.length,
    );
  },
  env: (host) => ({ GITLAB_HOST: host, NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", NO_COLOR: "1" }),
};
