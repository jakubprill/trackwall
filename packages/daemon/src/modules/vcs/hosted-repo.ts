import { type HostedRepo, RemoteRepoName } from "@trackwall/protocol";
import { z } from "zod";

/**
 * How GitHub and GitLab differ as repo hosts (§4.5, ADR-19): the list API path, search, response
 * fields and the `gh` / `glab` environment variables. Running the programs and filtering is in `hosting.ts`.
 */

export interface HostingApi {
  /** How many pages to fetch at most. */
  maxPages: number;
  /** Whether the repo host itself searches repos by `query`; otherwise the daemon filters the fetched pages. */
  searchesOnServer(query: string): boolean;
  /** The `<cli> api` path for one page of repos the user has access to; `query` only when `searchesOnServer`. */
  reposPage(page: number, pageSize: number, query: string): string;
  /** A page of the API response without archived repos; `received` is the number of repos on the page before filtering. */
  parseReposPage(json: unknown): { items: HostedRepo[]; received: number };
  /** Environment variables: the repo host for `repo clone`, and turning off prompts, colours and update checks. */
  env(host: string): NodeJS.ProcessEnv;
}

/**
 * Names that cannot be passed safely to `gh` or `glab` (outside `RemoteRepoName`) do not get onto the list:
 * GitHub and GitLab do not create such names, so it is at most a response that does not match the documentation.
 */
function page(all: HostedRepo[]): { items: HostedRepo[]; received: number } {
  return { items: all.filter((r) => RemoteRepoName.safeParse(r.fullName).success), received: all.length };
}

const GitHubRepos = z.array(
  z.object({
    full_name: z.string(),
    description: z.string().nullable(),
    html_url: z.string(),
    pushed_at: z.string().nullable(),
    archived: z.boolean(),
  }),
);

/**
 * `gh api user/repos`: own repos, collaborator repos and repos of organisations the user belongs to, by name.
 * This API has no search, so the daemon fetches up to 1000 repos and filters them itself; that is enough for OSS repos.
 */
export const githubApi: HostingApi = {
  maxPages: 10,
  searchesOnServer: () => false,
  reposPage: (page, pageSize) =>
    `user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=${pageSize}&page=${page}`,
  parseReposPage: (json) => {
    const all = GitHubRepos.parse(json);
    const { items } = page(
      all
        .filter((r) => !r.archived)
        .map((r) => ({ fullName: r.full_name, description: r.description || null, webUrl: r.html_url, updatedAt: r.pushed_at })),
    );
    return { items, received: all.length };
  },
  env: (host) => ({ GH_HOST: host, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" }),
};

const GitLabProjects = z.array(
  z.object({
    path_with_namespace: z.string(),
    description: z.string().nullable(),
    web_url: z.string(),
    last_activity_at: z.string().nullable(),
  }),
);

/** GitLab matches name fragments only from 3 characters; the daemon matches a shorter query itself on the first page. */
const GITLAB_MIN_SEARCH = 3;

/**
 * `glab api projects?membership=true`: projects the user is a member of (also through a group), most recently
 * changed first. A large self-hosted instance has thousands of them, so only one page, and GitLab search finds the rest
 * by name and path with the group (`search_namespaces`).
 */
export const gitlabApi: HostingApi = {
  maxPages: 1,
  searchesOnServer: (query) => query.length >= GITLAB_MIN_SEARCH,
  reposPage: (page, pageSize, query) => {
    const search = query === "" ? "" : `&search=${encodeURIComponent(query)}&search_namespaces=true`;
    return `projects?membership=true&archived=false&simple=true&order_by=last_activity_at&sort=desc&per_page=${pageSize}&page=${page}${search}`;
  },
  parseReposPage: (json) =>
    page(
      GitLabProjects.parse(json).map((p) => ({
        fullName: p.path_with_namespace,
        description: p.description || null,
        webUrl: p.web_url,
        updatedAt: p.last_activity_at,
      })),
    ),
  env: (host) => ({ GITLAB_HOST: host, NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", NO_COLOR: "1" }),
};
