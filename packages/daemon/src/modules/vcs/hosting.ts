import type { RepoHost, RepoHostKind } from "@trackwall/protocol";
import { gitEnv } from "./git.ts";
import { cloneable, githubApi, gitlabApi, type HostedRepo, type HostingApi } from "./hosted-repo.ts";
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
  github: { command: "gh", args: [] },
  gitlab: { command: "glab", args: [] },
};

const APIS: Record<RepoHostKind, HostingApi> = { github: githubApi, gitlab: gitlabApi };

/** Najwięcej, ile pozwalają GitHub i GitLab na jedną stronę. */
const PAGE_SIZE = 100;
/** Jedna strona API; dłużej to raczej brak sieci albo VPN. */
const PAGE_TIMEOUT_MS = 30_000;

export interface HostedRepos {
  /** W kolejności z hostingu (`HostingApi`). */
  repos: HostedRepo[];
  truncated: boolean;
}

export class Hosting {
  private readonly clis: HostingClis;

  constructor(clis: HostingClis) {
    this.clis = clis;
  }

  /** Repo pasujące do `query` (bez wielkości liter, w pełnej nazwie albo opisie); puste `query` to wszystkie. */
  async repos(host: RepoHost, query: string): Promise<HostedRepos> {
    const api = APIS[host.kind];
    const repos: HostedRepo[] = [];
    let truncated = true;
    for (let page = 1; page <= api.maxPages && truncated; page++) {
      const path = api.reposPage(page, PAGE_SIZE, api.searchesOnServer ? query : "");
      const { stdout } = await this.run(host, ["api", "--hostname", host.host, path], PAGE_TIMEOUT_MS);
      const pageRepos = parsePage(api, stdout.toString("utf8"), host);
      repos.push(...pageRepos.items);
      truncated = pageRepos.received === PAGE_SIZE;
    }
    const found = api.searchesOnServer ? repos : repos.filter((r) => matches(r, query));
    return { repos: cloneable(found), truncated };
  }

  /**
   * Klon `fullName` do `dest` (katalogu, którego jeszcze nie ma). Bez limitu czasu: duże repo klonuje się minutami,
   * a zabicie `gh` nie zatrzymałoby gita, którego uruchomił.
   */
  async clone(host: RepoHost, fullName: string, dest: string): Promise<void> {
    await this.run(host, ["repo", "clone", fullName, dest], undefined);
  }

  private run(host: RepoHost, args: string[], timeoutMs: number | undefined) {
    const cli = this.clis[host.kind];
    return runProgram(cli.command, [...cli.args, ...args], {
      label: `${HOSTING_CLIS[host.kind].command} ${args.slice(0, 2).join(" ")}`,
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
    throw new Error(`${HOSTING_CLIS[host.kind].command} api zwrócił odpowiedź niezgodną z API ${host.host}`);
  }
}

function matches(repo: HostedRepo, query: string): boolean {
  const q = query.toLowerCase();
  return repo.fullName.toLowerCase().includes(q) || (repo.description ?? "").toLowerCase().includes(q);
}
