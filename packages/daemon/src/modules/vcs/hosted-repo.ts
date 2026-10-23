import { RemoteRepoName } from "@trackwall/protocol";
import { z } from "zod";

/**
 * Wspólny kształt repo z API hostingu (§4.5, ADR-19) i to, czym różnią się GitHub i GitLab: ścieżka API listy,
 * pola odpowiedzi i zmienne środowiskowe `gh` / `glab`. Uruchamianie programów jest w `hosting.ts`.
 */

export interface HostedRepo {
  fullName: string;
  description: string | null;
  webUrl: string;
  updatedAt: string | null;
}

export interface HostingApi {
  /**
   * Ścieżka `<cli> api` dla jednej strony repo, do których użytkownik ma dostęp; `query` niepuste szuka po stronie
   * hostingu, jeśli `searchesOnServer`.
   */
  reposPage(page: number, pageSize: number, query: string): string;
  /** Hosting sam szuka po `query`; inaczej daemon filtruje pobrane strony. */
  searchesOnServer: boolean;
  /** Ile stron pobrać najwyżej. */
  maxPages: number;
  /** Strona odpowiedzi API bez zarchiwizowanych repo; `received` to liczba repo na stronie przed odfiltrowaniem. */
  parseReposPage(json: unknown): { items: HostedRepo[]; received: number };
  /** Zmienne środowiskowe: hosting dla `repo clone` i wyłączenie pytań, kolorów i sprawdzania aktualizacji. */
  env(host: string): NodeJS.ProcessEnv;
}

/**
 * Nazwy, których nie da się bezpiecznie podać `gh` ani `glab` (spoza `RemoteRepoName`), nie trafiają na listę:
 * GitHub i GitLab takich nie tworzą, więc to co najwyżej odpowiedź niezgodna z dokumentacją.
 */
export function cloneable(repos: HostedRepo[]): HostedRepo[] {
  return repos.filter((r) => RemoteRepoName.safeParse(r.fullName).success);
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
 * `gh api user/repos`: własne repo, repo współpracownika i repo organizacji, do których użytkownik należy, po nazwie.
 * To API nie ma wyszukiwania, więc daemon pobiera do 1000 repo i filtruje je sam; tyle wystarcza dla repo OSS.
 */
export const githubApi: HostingApi = {
  searchesOnServer: false,
  maxPages: 10,
  reposPage: (page, pageSize) =>
    `user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=${pageSize}&page=${page}`,
  parseReposPage: (json) => {
    const page = GitHubRepos.parse(json);
    const items = page
      .filter((r) => !r.archived)
      .map((r) => ({ fullName: r.full_name, description: r.description || null, webUrl: r.html_url, updatedAt: r.pushed_at }));
    return { items, received: page.length };
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

/**
 * `glab api projects?membership=true`: projekty, których użytkownik jest członkiem (także przez grupę), od ostatnio
 * zmienianych. Instancja firmowa ma ich tysiące, więc bez zapytania tylko pierwsza strona, a resztę znajduje
 * wyszukiwanie GitLab po nazwie i ścieżce z grupą (`search_namespaces`).
 */
export const gitlabApi: HostingApi = {
  searchesOnServer: true,
  maxPages: 1,
  reposPage: (page, pageSize, query) => {
    const search = query === "" ? "" : `&search=${encodeURIComponent(query)}&search_namespaces=true`;
    return `projects?membership=true&archived=false&simple=true&order_by=last_activity_at&sort=desc&per_page=${pageSize}&page=${page}${search}`;
  },
  parseReposPage: (json) => {
    const page = GitLabProjects.parse(json);
    const items = page.map((p) => ({
      fullName: p.path_with_namespace,
      description: p.description || null,
      webUrl: p.web_url,
      updatedAt: p.last_activity_at,
    }));
    return { items, received: page.length };
  },
  env: (host) => ({ GITLAB_HOST: host, NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", NO_COLOR: "1" }),
};
