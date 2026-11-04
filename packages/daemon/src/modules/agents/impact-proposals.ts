import {
  type ChangedEndpoints,
  cutText,
  endpointsCalledBy,
  handingTaskName,
  handoffPrompt,
  type ImpactedRepo,
  MAX_CHANGED_ENDPOINTS,
  MAX_CHANGED_TYPES,
  proposalRepos,
  TASK_TITLE_MAX,
  type Task,
  type TaskProposal,
  typesUsedBy,
} from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { KeyedQueue } from "../../infra/keyed-queue.ts";
import type { NewProposal } from "./task-proposals.ts";

/**
 * Impact proposals (§4.4, ADR-198, ADR-201): when a turn of a task's session ends, the daemon compares the task's commits
 * with its base, as `get_changed_endpoints` does (ADR-145, ADR-147), and proposes a task to each repo of ring 1 that
 * surely calls an endpoint they removed or changed, and to each repo that imports a public library type they removed or
 * changed, unless that repo was offered every such endpoint and type before. The proposal is
 * the task's own (its session proposes it, ADR-140), so nothing starts until the user approves it, and an approved one
 * is the task's subtask with its handoff (ADR-143). Further rings are left to the subtasks: a repo of ring 2 needs work
 * only when a repo of ring 1 changes its own endpoints, and that subtask's turn then proposes it.
 */

/** The longest key kept in `tasks.json`: a method and a path, or a type's name, which a card does not cut. */
export const IMPACT_KEY_MAX = 600;
/** Most keys kept per repo: one comparison has at most this many endpoints and types. */
export const IMPACT_KEYS_MAX = MAX_CHANGED_ENDPOINTS + MAX_CHANGED_TYPES;

/** A repo to offer a task, with what it uses that the task's commits changed. */
interface ImpactOffer {
  repo: string;
  /**
   * The keys of every removed or changed endpoint the repo calls (`METHOD path`) and library type it imports
   * (`type name`), the ones offered before included.
   */
  keys: string[];
  reached: ImpactedRepo;
}

/** How an offered endpoint is remembered: its method and path, which survive a change of its contract. */
function impactEndpointKey({ method, path }: { method: string | null; path: string }): string {
  return cutText(`${method ?? "ANY"} ${path}`, IMPACT_KEY_MAX);
}

/** How an offered library type is remembered: its fully qualified name, which survives a change of its members. */
function impactTypeKey({ type }: { type: string }): string {
  return cutText(`type ${type}`, IMPACT_KEY_MAX);
}

/**
 * The repos to offer a task: one of ring 1, sure, calling a removed or changed endpoint, or one importing a removed or
 * changed library type, with something that is not in what the repo was offered before (`offered`, by repo). A
 * maybe-reached repo stays in the Impact tab for the user to judge.
 */
export function impactOffers(
  changed: Pick<ChangedEndpoints, "endpoints" | "types" | "impact">,
  offered: Readonly<Record<string, readonly string[]>>,
): ImpactOffer[] {
  return changed.impact.flatMap((reached) => {
    const calls = reached.ring === 1 && reached.sure ? endpointsCalledBy(changed.endpoints, reached.repo).map(impactEndpointKey) : [];
    const keys = [...new Set([...calls, ...typesUsedBy(changed.types, reached.repo).map(impactTypeKey)])];
    const known = new Set(offered[reached.repo] ?? []);
    return keys.some((k) => !known.has(k)) ? [{ repo: reached.repo, keys, reached }] : [];
  });
}

/**
 * What a repo was offered after one more offer: the newest first, since one comparison has at most
 * `IMPACT_KEYS_MAX` keys, so an offer is always kept whole and never made again for the same endpoints and types.
 */
export function offeredAfter(before: readonly string[], offer: readonly string[]): string[] {
  return [...new Set([...offer, ...before])].slice(0, IMPACT_KEYS_MAX);
}

/** What the impact proposals read and write of the task list (`AgentTasks`). */
interface ImpactTasks {
  /** A listed task, `undefined` once it ended. */
  find(id: string): Task | undefined;
  list(): Task[];
  handoff(id: string): { repo: string } | null;
  change(id: string): { parts: { repo: string }[] } | null;
  /** The endpoints and types each repo was offered from task `id`'s impact, by key. */
  impactProposed(id: string): Readonly<Record<string, readonly string[]>>;
  markImpactProposed(id: string, repo: string, keys: readonly string[]): void;
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
  /** The removed and changed endpoints and library types of a task's commits with the repos they reach (`AgentsDeps.taskImpact`). */
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
   * A turn of session `session` of task `task` ended, so its commits may now change endpoints other repos call or types
   * they import. Never
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
      this.#deps.tasks.markImpactProposed(id, offer.repo, offer.keys);
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
