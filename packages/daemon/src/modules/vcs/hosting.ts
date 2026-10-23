import { HOST_CLI, type HostedRepo, hostKey, type RepoHost, type RepoHostKind } from "@trackwall/protocol";
import { gitEnv } from "./git.ts";
import { githubApi, gitlabApi, type HostingApi } from "./hosted-repo.ts";
import { runProgram } from "./run.ts";

/**
 * Hostingi repo w module `vcs` (§4.5, ADR-19): lista repo dostępnych dla użytkownika i klon wybranego, przez
 * `gh` (GitHub) i `glab` (GitLab). Logowanie i token należą do tych programów (`gh auth login`, `glab auth login`),
 * więc Trackwall nie widzi ani nie zapisuje tokenu, a klon używa protokołu (SSH albo HTTPS) i poświadczeń
 * ustawionych w nich przez użytkownika.
 */

/** Program hostingu z argumentami przed komendą; w testach atrapa uruchamiana przez Bun albo Node. */
interface HostingCli {
  command: string;
  args: readonly string[];
}

export type HostingClis = Record<RepoHostKind, HostingCli>;

export const HOSTING_CLIS: HostingClis = {
  github: { command: HOST_CLI.github, args: [] },
  gitlab: { command: HOST_CLI.gitlab, args: [] },
};

const APIS: Record<RepoHostKind, HostingApi> = { github: githubApi, gitlab: gitlabApi };

/** Najwięcej, ile pozwalają GitHub i GitLab na jedną stronę. */
const PAGE_SIZE = 100;
/** Jedna strona API; dłużej to raczej brak sieci albo VPN. */
const PAGE_TIMEOUT_MS = 30_000;
/**
 * Jak długo pobrane strony służą kolejnym zapytaniom: wyszukiwanie filtrowane w daemonie (GitHub, krótkie zapytanie
 * w GitLab) nie pobiera listy przy każdym znaku, a nowe repo w hostingu pojawia się najpóźniej po tym czasie.
 */
const CACHE_MS = 60_000;
/**
 * Klon dużego repo trwa minutami, ale ssh czekające na potwierdzenie klucza hosta w ukrytej konsoli trwałoby
 * zawsze. Po tym czasie klonowanie jest nieudane; git uruchomiony przez `gh` / `glab` może jednak żyć dalej,
 * bo nie jest w grupie procesów (§4.5).
 */
const CLONE_TIMEOUT_MS = 30 * 60_000;

export interface HostedRepos {
  /** W kolejności z hostingu (`HostingApi`). */
  repos: HostedRepo[];
  /** Pobrano tyle stron, ile pozwala `maxPages`, a ostatnia była pełna. */
  truncated: boolean;
}

export class Hosting {
  private readonly clis: HostingClis;
  private readonly cache = new Map<string, { at: number; fetched: Promise<HostedRepos> }>();

  constructor(clis: HostingClis) {
    this.clis = clis;
  }

  /** Repo pasujące do `query` (bez wielkości liter, w pełnej nazwie albo opisie); puste `query` to wszystkie. */
  async repos(host: RepoHost, query: string): Promise<HostedRepos> {
    const api = APIS[host.kind];
    const onServer = api.searchesOnServer(query);
    const { repos, truncated } = await this.fetchCached(host, onServer ? query : "");
    return { repos: onServer ? repos : repos.filter((r) => matches(r, query)), truncated };
  }

  /** Klon `fullName` do `dest` (katalogu, którego jeszcze nie ma). */
  async clone(host: RepoHost, fullName: string, dest: string): Promise<void> {
    await this.run(host, ["repo", "clone", fullName, dest], CLONE_TIMEOUT_MS);
  }

  /** Nieudane pobranie nie zostaje w pamięci, więc „Spróbuj ponownie” po zalogowaniu pyta hosting od nowa. */
  private fetchCached(host: RepoHost, serverQuery: string): Promise<HostedRepos> {
    const now = Date.now();
    for (const [key, entry] of this.cache) if (now - entry.at > CACHE_MS) this.cache.delete(key);
    const key = `${hostKey(host)}\n${serverQuery}`;
    const cached = this.cache.get(key);
    if (cached) return cached.fetched;
    const fetched = this.fetch(host, serverQuery);
    this.cache.set(key, { at: now, fetched });
    fetched.catch(() => this.cache.delete(key));
    return fetched;
  }

  private async fetch(host: RepoHost, serverQuery: string): Promise<HostedRepos> {
    const api = APIS[host.kind];
    const repos: HostedRepo[] = [];
    let truncated = true;
    for (let page = 1; page <= api.maxPages && truncated; page++) {
      const { stdout } = await this.run(
        host,
        ["api", "--hostname", host.host, api.reposPage(page, PAGE_SIZE, serverQuery)],
        PAGE_TIMEOUT_MS,
      );
      const pageRepos = parsePage(api, stdout.toString("utf8"), host);
      repos.push(...pageRepos.items);
      truncated = pageRepos.received === PAGE_SIZE;
    }
    return { repos, truncated };
  }

  private run(host: RepoHost, args: string[], timeoutMs: number) {
    const cli = this.clis[host.kind];
    return runProgram(cli.command, [...cli.args, ...args], {
      label: `${HOST_CLI[host.kind]} ${args[0]}`,
      env: { ...gitEnv(), ...APIS[host.kind].env(host.host) },
      timeoutMs,
    });
  }
}

/** Odpowiedź API to dane z zewnątrz: JSON sprawdzony schematem, a błąd bez zrzutu odpowiedzi. */
function parsePage(api: HostingApi, text: string, host: RepoHost): ReturnType<HostingApi["parseReposPage"]> {
  try {
    return api.parseReposPage(JSON.parse(text));
  } catch {
    throw new Error(`${HOST_CLI[host.kind]} api zwrócił odpowiedź niezgodną z API ${host.host}`);
  }
}

function matches(repo: HostedRepo, query: string): boolean {
  const q = query.toLowerCase();
  return repo.fullName.toLowerCase().includes(q) || (repo.description ?? "").toLowerCase().includes(q);
}
