import type { ServerCheckState } from "@trackwall/protocol";
import { failureLog } from "../../infra/failure-log.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * The server check (§4.5, ADR-295): every 15 minutes the daemon asks the server of each repo whether the branch the
 * checked-out branch tracks or the default branch moved since the repo's last fetch (`vcs.newOnServer`: `git ls-remote`
 * outside the repo, with only the user's own sign-in, as the doctor asks, ADR-195), so "All repos" shows the repos with
 * new commits on the server, and the New task form a default branch a task would start behind (ADR-296).
 * It fetches nothing: a fetch in the background would run what a repo's own configuration names (§8), and the user's
 * Pull or "Sync all" brings the commits. Why a server did not answer is the doctor's to explain, so a round keeps no
 * message, and none reaches the log, where a token someone put in a remote's address would stay.
 */

/** How often each server is asked. */
const ROUND_EVERY_MS = 15 * 60_000;
/**
 * How often the check looks whether a round is due: the first round comes this long after the daemon starts, out of the
 * way of its start, and as long after the check is turned on.
 */
const TICK_MS = 60_000;
/** Repos asked at once: each is one connection, mostly to the same server. */
const AT_ONCE = 4;

type Round = NonNullable<ServerCheckState["last"]>;

/** What the check needs from `workspace` and `vcs`; wired in the facade. */
export interface ServerCheckDeps {
  repos: { repoEntries(): Promise<RepoEntry[]> };
  /** The remote-tracking branches the server moved past (`origin/main`); an exception: a server did not answer, or git could not read the repo. */
  vcs: { newOnServer(dir: string): Promise<string[]> };
  /** `serverCheck` in `workspace.yaml`, read before every round, so turning it off stops the next one. */
  on: () => boolean;
  now: () => Date;
  log: (msg: string) => void;
}

export class ServerCheck {
  readonly #deps: ServerCheckDeps;
  #last: Round | null = null;
  #timer: NodeJS.Timeout | undefined;
  /** A slow or absent server must not stack rounds: the next one starts only after the previous one ended. */
  #running: Promise<void> | undefined;
  /** A missing projects folder fails every round: the log gets its message once, not every minute. */
  readonly #report: (job: Promise<unknown>) => void;

  constructor(deps: ServerCheckDeps) {
    this.#deps = deps;
    this.#report = failureLog("server check", deps.log);
  }

  start(tickMs = TICK_MS): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#report(this.checkIfDue()), tickMs);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The snapshot `workspaceApi.serverCheck` answers with; turned off, the check shows no round, not even an old one. */
  state(): ServerCheckState {
    const on = this.#deps.on();
    return { on, last: on ? this.#last : null };
  }

  /**
   * A round when one is due: the check is on, and no round has ended yet or the last one ended 15 minutes ago or more.
   * A call during a running round gets that one instead of starting another. Turned off, the last round is forgotten.
   * Async, so that a `workspace.yaml` that cannot be read (held by another program on Windows) rejects into the log
   * instead of throwing out of the timer, which would end the daemon (`uncaughtException` in `main.ts`).
   */
  async checkIfDue(): Promise<void> {
    if (!this.#deps.on()) {
      this.#last = null;
      return;
    }
    if (this.#running) return this.#running;
    if (this.#last !== null && this.#deps.now().getTime() - Date.parse(this.#last.endedAt) < ROUND_EVERY_MS) return;
    this.#running = this.#round().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** A repo list that cannot be read throws before any server is asked, and the previous round stays. */
  async #round(): Promise<void> {
    const entries = await this.#deps.repos.repoEntries();
    const asked = await mapLimit(entries, AT_ONCE, async ({ id, path }) => {
      // Before git reads the repo's remote-tracking ref: a fetch after this moment has brought what the server has now.
      const checkedAt = this.#deps.now().toISOString();
      const moved = await this.#deps.vcs.newOnServer(path).catch(() => undefined);
      return { repo: id, checkedAt, moved };
    });
    this.#last = {
      endedAt: this.#deps.now().toISOString(),
      newCommits: asked.flatMap(({ repo, checkedAt, moved }) => (moved?.length ? [{ repo, checkedAt, remoteBranches: moved }] : [])),
      unreached: asked.filter((a) => a.moved === undefined).map((a) => a.repo),
    };
  }
}
