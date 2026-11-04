import { type ChangedEndpoints, cutText, endpointsCalledBy, type ImpactedRepo, TASK_TITLE_MAX, type Task } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";

/**
 * Impact proposals (§4.4, ADR-198): when a turn of a task's session ends, the daemon compares the task's commits with
 * its base, as `get_changed_endpoints` does (ADR-145, ADR-147), and proposes a task to each repo of ring 1 that surely
 * calls an endpoint they removed or changed, unless that repo was offered every such endpoint before. The proposal is
 * the task's own (its session proposes it, ADR-140), so nothing starts until the user approves it, and an approved one
 * is the task's subtask with its handoff (ADR-143). Further rings are left to the subtasks: a repo of ring 2 needs work
 * only when a repo of ring 1 changes its own endpoints, and that subtask's turn then proposes it.
 */

/** The longest endpoint key kept in `tasks.json`: a method and a path, which a card does not cut. */
export const IMPACT_ENDPOINT_KEY_MAX = 600;

/** A repo to offer a task, with the endpoints it calls that the task's commits changed. */
export interface ImpactOffer {
  repo: string;
  /** `METHOD path` of every removed or changed endpoint the repo calls, the ones offered before included. */
  endpoints: string[];
  reached: ImpactedRepo;
}

/** How an offered endpoint is remembered: its method and path, which survive a change of its contract. */
function impactEndpointKey({ method, path }: { method: string | null; path: string }): string {
  return cutText(`${method ?? "ANY"} ${path}`, IMPACT_ENDPOINT_KEY_MAX);
}

/**
 * The repos to offer a task: ring 1, sure, calling a removed or changed endpoint that is not in what the repo was
 * offered before (`offered`, by repo). A maybe-reached repo stays in the Impact tab for the user to judge.
 */
export function impactOffers(
  changed: Pick<ChangedEndpoints, "endpoints" | "impact">,
  offered: Readonly<Record<string, readonly string[]>>,
): ImpactOffer[] {
  return changed.impact.flatMap((reached) => {
    if (reached.ring !== 1 || !reached.sure) return [];
    const endpoints = [...new Set(endpointsCalledBy(changed.endpoints, reached.repo).map(impactEndpointKey))];
    const known = new Set(offered[reached.repo] ?? []);
    return endpoints.some((e) => !known.has(e)) ? [{ repo: reached.repo, endpoints, reached }] : [];
  });
}

/** The title of an impact proposal: the repo whose API changed. */
export function impactProposalTitle(task: Pick<Task, "repo">): string {
  return cutText(`Update to the API change in ${task.repo}`, TASK_TITLE_MAX);
}

/** How a proposal's prompt names the task: its title, or the first line of its prompt cut like a title. */
export function impactTaskName(task: Pick<Task, "title" | "prompt">): string {
  return task.title ?? cutText(task.prompt.trim().split(/\r?\n/, 1)[0] ?? "", TASK_TITLE_MAX);
}

/** What the impact proposals need from the task list and the proposals (`Agents`). */
export interface ImpactProposalDeps {
  /** A listed task, `undefined` once it ended. */
  task: (id: string) => Task | undefined;
  /** The endpoints each repo was offered from task `id`'s impact. */
  offered: (id: string) => Readonly<Record<string, readonly string[]>>;
  markOffered: (id: string, repo: string, endpoints: readonly string[]) => void;
  /**
   * The repos where task `id`'s work already goes on or came from: its own, the handing task's, its change's parts, and
   * the repos of the proposals and tasks it made. Such a repo is not offered a second task; its endpoints count as offered.
   */
  workedRepos: (id: string) => ReadonlySet<string>;
  /** The removed and changed endpoints of a task's commits with the repos they reach (`Facade.taskChangedEndpoints`). */
  impact: (task: Task) => Promise<ChangedEndpoints>;
  /** Adds the proposal from session `session` of the task; throws when the list of proposals is full. */
  propose: (session: string, offer: ImpactOffer, changed: ChangedEndpoints) => void;
  log: (message: string) => void;
}

export class ImpactProposals {
  readonly #deps: ImpactProposalDeps;
  /** The check under way per task: turns that end close together are checked one after another, never twice at once. */
  readonly #checks = new Map<string, Promise<void>>();

  constructor(deps: ImpactProposalDeps) {
    this.#deps = deps;
  }

  /** A turn of session `session` of task `task` ended, so its commits may now change endpoints other repos call. */
  turnOver(task: string, session: string): Promise<void> {
    const check = (this.#checks.get(task) ?? Promise.resolve()).then(() => this.#check(task, session));
    this.#checks.set(task, check);
    void check.finally(() => {
      if (this.#checks.get(task) === check) this.#checks.delete(task);
    });
    return check;
  }

  async #check(id: string, session: string): Promise<void> {
    const task = this.#deps.task(id);
    if (task === undefined) return;
    let changed: ChangedEndpoints;
    try {
      changed = await this.#deps.impact(task);
    } catch (err) {
      this.#deps.log(`task ${id}: reading the impact of its commits: ${messageOf(err)}`);
      return;
    }
    const worked = this.#deps.workedRepos(id);
    for (const offer of impactOffers(changed, this.#deps.offered(id))) {
      if (!worked.has(offer.repo)) {
        try {
          this.#deps.propose(session, offer, changed);
        } catch (err) {
          this.#deps.log(`task ${id}: proposing a task in ${offer.repo} from its impact: ${messageOf(err)}`);
          return;
        }
      }
      this.#deps.markOffered(id, offer.repo, offer.endpoints);
    }
  }
}
