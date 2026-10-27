import {
  HOST_CLI,
  type HostedProject,
  type HostedRepo,
  hostKey,
  type MergeRequest,
  type MergeRequestForm,
  type RepoHost,
  type RepoHostKind,
} from "@trackwall/protocol";
import { runProgram } from "../../infra/run-program.ts";
import { gitEnv } from "./git.ts";
import { findMergeRequest, mergeRequestFormUrl } from "./hosted-merge-request.ts";
import { githubApi, gitlabApi, type HostingApi } from "./hosted-repo.ts";

/**
 * Repo hosts in the `vcs` module (§4.5, ADR-19): the list of repos available to the user, a clone of the chosen one and the
 * merge request of a task branch with its pipeline (ADR-77), through `gh` (GitHub) and `glab` (GitLab). Sign-in and the token belong to those programs (`gh auth login`, `glab auth login`),
 * so Trackwall neither sees nor stores the token, and the clone uses the protocol (SSH or HTTPS) and credentials
 * the user set in them.
 */

/** The repo host's program with arguments before the command; in tests a fake run by Bun or Node. */
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

/** The most GitHub and GitLab allow per page. */
const PAGE_SIZE = 100;
/** One API page; taking longer usually means there is no network or the VPN is down. */
const PAGE_TIMEOUT_MS = 30_000;
/**
 * How long fetched pages serve later queries: a search filtered in the daemon (GitHub, a short query
 * in GitLab) does not fetch the list on every keystroke, and a new repo on the repo host appears after this time at the latest.
 */
const CACHE_MS = 60_000;
/**
 * A clone of a large repo takes minutes, but ssh waiting for host key confirmation in a hidden console would take
 * forever. After this time the clone has failed; git started by `gh` / `glab` may however keep running,
 * because it is not in a process group (§4.5).
 */
const CLONE_TIMEOUT_MS = 30 * 60_000;

export interface HostedRepos {
  /** In the repo host's order (`HostingApi`). */
  repos: HostedRepo[];
  /** As many pages were fetched as `maxPages` allows, and the last one was full. */
  truncated: boolean;
}

export class Hosting {
  private readonly clis: HostingClis;
  private readonly cache = new Map<string, { at: number; fetched: Promise<HostedRepos> }>();

  constructor(clis: HostingClis) {
    this.clis = clis;
  }

  /** Repos matching `query` (case-insensitive, in the full name or description); an empty `query` is all of them. */
  async repos(host: RepoHost, query: string): Promise<HostedRepos> {
    const api = APIS[host.kind];
    const onServer = api.searchesOnServer(query);
    const { repos, truncated } = await this.fetchCached(host, onServer ? query : "");
    return { repos: onServer ? repos : repos.filter((r) => matches(r, query)), truncated };
  }

  /** A clone of `fullName` into `dest` (a directory that does not exist yet). */
  async clone(host: RepoHost, fullName: string, dest: string): Promise<void> {
    await this.run(host, ["repo", "clone", fullName, dest], CLONE_TIMEOUT_MS);
  }

  /** The address of the repo host's new merge request form with `form` filled in (ADR-77); nothing is sent to the repo host. */
  mergeRequestForm(project: HostedProject, form: MergeRequestForm): string {
    return mergeRequestFormUrl(project, form);
  }

  /**
   * The most recently updated merge request from `branch` in `project`, with its pipeline (ADR-77); `null` when there is
   * none. Only reads: the user creates the merge request in the repo host's form.
   */
  mergeRequest(project: HostedProject, branch: string): Promise<MergeRequest | null> {
    const host = { kind: project.kind, host: project.host };
    return findMergeRequest((path, schema) => this.api(host, path, (json) => schema.parse(json)), project, branch);
  }

  /** Resolves when `gh` or `glab` is signed in to `host` (`auth status` ends with 0); the doctor asks it (ADR-101). */
  async signedIn(host: RepoHost, timeoutMs: number): Promise<void> {
    await this.run(host, ["auth", "status", "--hostname", host.host], timeoutMs);
  }

  /** A failed fetch does not stay in memory, so "Try again" after signing in asks the repo host anew. */
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
      const pageRepos = await this.api(host, api.reposPage(page, PAGE_SIZE, serverQuery), (json) => api.parseReposPage(json));
      repos.push(...pageRepos.items);
      truncated = pageRepos.received === PAGE_SIZE;
    }
    return { repos, truncated };
  }

  /** One `<cli> api` call; the response is outside data, so JSON checked by `parse`, and an error without a dump of it. */
  private async api<T>(host: RepoHost, path: string, parse: (json: unknown) => T): Promise<T> {
    const { stdout } = await this.run(host, ["api", "--hostname", host.host, path], PAGE_TIMEOUT_MS);
    try {
      return parse(JSON.parse(stdout.toString("utf8")));
    } catch {
      throw new Error(`${HOST_CLI[host.kind]} api returned a response that does not match the ${host.host} API`);
    }
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

function matches(repo: HostedRepo, query: string): boolean {
  const q = query.toLowerCase();
  return repo.fullName.toLowerCase().includes(q) || (repo.description ?? "").toLowerCase().includes(q);
}
