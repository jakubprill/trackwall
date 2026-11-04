import {
  type ChangedEndpoints,
  cutText,
  endpointsCalledBy,
  handingTaskName,
  handoffPrompt,
  type ImpactedRepo,
  MAX_CHANGED_ENDPOINTS,
  proposalRepos,
  TASK_TITLE_MAX,
  type Task,
  type TaskProposal,
} from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { KeyedQueue } from "../../infra/keyed-queue.ts";
import type { NewProposal } from "./task-proposals.ts";

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
interface ImpactOffer {
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

/**
 * What a repo was offered after one more offer: the newest first, since one comparison has at most
 * `MAX_CHANGED_ENDPOINTS`, so an offer is always kept whole and never made again for the same endpoints.
 */
export function offeredAfter(before: readonly string[], offer: readonly string[]): string[] {
  return [...new Set([...offer, ...before])].slice(0, MAX_CHANGED_ENDPOINTS);
}

/** What the impact proposals read and write of the task list (`AgentTasks`). */
interface ImpactTasks {
  /** A listed task, `undefined` once it ended. */
  find(id: string): Task | undefined;
  list(): Task[];
  handoff(id: string): { repo: string } | null;
  change(id: string): { parts: { repo: string }[] } | null;
  /** The endpoints each repo was offered from task `id`'s impact. */
  impactProposed(id: string): Readonly<Record<string, readonly string[]>>;
  markImpactProposed(id: string, repo: string, endpoints: readonly string[]): void;
}

/** What the impact proposals do with the proposals waiting for the user (`TaskProposals`). */
interface ImpactProposalList {
  list(): TaskProposal[];
  /** Throws when the list is full (`MAX_PENDING_PROPOSALS`). */
  add(proposal: NewProposal): TaskProposal;
  withdraw(id: string): void;
}

export interface ImpactProposalDeps {
  tasks: ImpactTasks;
  proposals: ImpactProposalList;
  /** The removed and changed endpoints of a task's commits with the repos they reach (`AgentsDeps.taskImpact`). */
  impact: (task: Task) => Promise<ChangedEndpoints>;
  log: (message: string) => void;
}

export class ImpactProposals {
  readonly #deps: ImpactProposalDeps;
  /** Turns of one task that end close together are checked one after another, so a repo is never proposed twice. */
  readonly #checks = new KeyedQueue();

  constructor(deps: ImpactProposalDeps) {
    this.#deps = deps;
  }

  /**
   * A turn of session `session` of task `task` ended, so its commits may now change endpoints other repos call. Never
   * fails: a failed check is logged, and the next turn checks again.
   */
  turnOver(task: string, session: string): Promise<void> {
    return this.#checks.run(task, async () => {
      try {
        await this.#check(task, session);
      } catch (err) {
        this.#deps.log(`task ${task}: proposing tasks from its impact: ${messageOf(err)}`);
      }
    });
  }

  /**
   * Work for `repos` started or was proposed otherwise from task `task` (its agent's own proposal, a hand-off from the
   * Impact tab): the impact proposals of that task waiting there go, without a rejection, since nobody waits for them.
   */
  replacedBy(task: string, repos: readonly string[]): void {
    for (const p of this.#deps.proposals.list())
      if (p.fromImpact && p.proposedBy.task === task && repos.includes(p.repo)) this.#deps.proposals.withdraw(p.id);
  }

  async #check(id: string, session: string): Promise<void> {
    const task = this.#deps.tasks.find(id);
    if (task === undefined) return;
    const changed = await this.#deps.impact(task);
    const worked = this.#workedRepos(task);
    for (const offer of impactOffers(changed, this.#deps.tasks.impactProposed(id))) {
      // A full list refuses the proposal: the check stops before marking it, so the next turn offers it again.
      if (!worked.has(offer.repo)) this.#deps.proposals.add(impactProposal(task, session, offer, changed));
      this.#deps.tasks.markImpactProposed(id, offer.repo, offer.endpoints);
    }
  }

  /**
   * The repos where the task's work already goes on or came from: its own, the handing task's, its change's parts, and
   * the repos of the proposals and tasks it made. Such a repo gets no proposal, and its endpoints count as offered.
   */
  #workedRepos(task: Task): Set<string> {
    const { tasks, proposals } = this.#deps;
    const repos = new Set([task.repo]);
    const handoff = tasks.handoff(task.id);
    if (handoff !== null) repos.add(handoff.repo);
    for (const part of tasks.change(task.id)?.parts ?? []) repos.add(part.repo);
    for (const p of proposals.list()) if (p.proposedBy.task === task.id) for (const repo of proposalRepos(p)) repos.add(repo);
    for (const t of tasks.list()) if (t.proposedBy?.task === task.id) repos.add(t.repo);
    return repos;
  }
}

/** The task's own proposal from session `session` for one offered repo, with the Impact tab's hand-off prompt. */
function impactProposal(task: Task, session: string, { repo, reached }: ImpactOffer, changed: ChangedEndpoints): NewProposal {
  return {
    kind: "task",
    repo,
    title: cutText(`Update to the API change in ${task.repo}`, TASK_TITLE_MAX),
    prompt: handoffPrompt(changed, handingTaskName(task), reached),
    model: null,
    approvals: "ask",
    item: null,
    parts: null,
    fromImpact: true,
    // A task's session is never the supervisor; the task is what proposes (ADR-140), whichever of its sessions runs.
    proposedBy: { session, supervisor: false, task: task.id },
  };
}
