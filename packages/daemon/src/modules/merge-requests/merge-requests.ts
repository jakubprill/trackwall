import type {
  BranchOnRemote,
  HostedProject,
  MergeRequest,
  MergeRequestDraft,
  MergeRequestForm,
  MergeRequestLookup,
  RepoHost,
  Task,
  TaskMergeRequest,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";

/**
 * The `merge-requests` module (§4, §4.12, ADR-77): a finished task on its way to a merge request. The user pushes the
 * task branch from the task panel and opens the repo host's new merge request form with the title and description
 * they approved, and creates the merge request there; the panel then follows that merge request and its pipeline,
 * found by the task branch as its source branch. The daemon creates nothing on the repo host, so it needs no
 * permission there beyond what `gh` and `glab` already read with, and a merge request made any other way (by the
 * user, an agent, another MCP server) shows the same. Kept only in memory: the repo host's last answers, briefly.
 */

/** Repo host answers serve every panel and window for this long: the panel asks every half minute, and pipelines take minutes. */
const LOOKUP_CACHE_MS = 15_000;

/** What the module needs from `agents`: a task, and its commits and uncommitted files. */
interface MergeRequestTasks {
  task(id: string): Task;
  taskChangesSummary(id: string): Promise<{ commits: number; uncommitted: number }>;
}

/** What the module needs from `vcs`: the main remote as a project on a repo host, the task branch against it, and its push. */
interface MergeRequestVcs {
  hostedProject(dir: string, hosts: readonly RepoHost[]): Promise<HostedProject | null>;
  branchOnRemote(dir: string, branch: string, base: string): Promise<BranchOnRemote | null>;
  pushBranch(dir: string, branch: string): Promise<void>;
}

/** What the module needs from the repo hosts in `vcs`: the merge request from a branch, and the new merge request form. */
interface MergeRequestHosting {
  mergeRequest(project: HostedProject, branch: string): Promise<MergeRequest | null>;
  mergeRequestForm(project: HostedProject, form: MergeRequestForm): string;
}

export interface MergeRequestsDeps {
  tasks: MergeRequestTasks;
  vcs: MergeRequestVcs;
  hosting: MergeRequestHosting;
  /** The repo hosts from the settings (`workspace`), to tell a GitLab remote from an unknown host. */
  repoHosts: () => RepoHost[];
  openUrl: (url: string) => void;
}

export class MergeRequests {
  readonly #deps: MergeRequestsDeps;
  /** The repo host's last answer per task; a failed one is not kept, so the next read asks again. */
  readonly #lookups = new Map<string, { at: number; lookup: Promise<MergeRequestLookup> }>();
  /** Tasks whose branch is being pushed: a second push at once is refused. */
  readonly #pushing = new Set<string>();

  constructor(deps: MergeRequestsDeps) {
    this.#deps = deps;
  }

  async get(id: string): Promise<TaskMergeRequest> {
    const task = this.#deps.tasks.task(id);
    const [changes, onRemote, project] = await Promise.all([
      this.#deps.tasks.taskChangesSummary(id),
      asRepoUnavailable(task, this.#deps.vcs.branchOnRemote(task.worktree, task.branch, task.base)),
      asRepoUnavailable(task, this.#deps.vcs.hostedProject(task.worktree, this.#deps.repoHosts())),
    ]);
    const push = onRemote && { ...onRemote, commits: changes.commits, uncommitted: changes.uncommitted };
    const lookup = project && push?.published ? await this.#lookup(task, project) : null;
    return { task: id, push, project, lookup, targetBranch: task.baseBranch };
  }

  /** Pushes the task branch at the user's request: never forced, and refused while it has no commits. */
  async push(id: string): Promise<TaskMergeRequest> {
    const task = this.#deps.tasks.task(id);
    if (this.#pushing.has(id)) throw new DomainError("bad_request", `branch ${task.branch} is already being pushed`);
    this.#pushing.add(id);
    try {
      const { commits } = await this.#deps.tasks.taskChangesSummary(id);
      if (commits === 0)
        throw new DomainError("bad_request", `branch ${task.branch} has no commits yet; ask the agent to commit its changes`);
      await asRepoUnavailable(task, this.#deps.vcs.pushBranch(task.worktree, task.branch));
    } finally {
      this.#pushing.delete(id);
      this.#lookups.delete(id);
    }
    return this.get(id);
  }

  /**
   * Opens the repo host's form for a merge request from the task branch with the draft the user approved. Refused when
   * the form would not show what the user reviewed (commits not pushed yet) or would make a second open merge request.
   */
  async openForm(draft: MergeRequestDraft): Promise<void> {
    const task = this.#deps.tasks.task(draft.task);
    const state = await this.get(draft.task);
    if (!state.project)
      throw new DomainError(
        "bad_request",
        `the main remote of ${task.repo} is not on GitHub or on a repo host from the settings; add its repo host in Settings`,
      );
    if (!state.push?.published || state.push.unpushed > 0)
      throw new DomainError("bad_request", `push branch ${task.branch} first, so the merge request has every commit`);
    if (state.lookup?.kind === "found" && state.lookup.mergeRequest.state === "open")
      throw new DomainError("bad_request", `branch ${task.branch} already has an open merge request: ${state.lookup.mergeRequest.url}`);
    const { title, description } = draft;
    this.#deps.openUrl(
      this.#deps.hosting.mergeRequestForm(state.project, { source: task.branch, target: state.targetBranch, title, description }),
    );
  }

  #lookup(task: Task, project: HostedProject): Promise<MergeRequestLookup> {
    const key = task.id;
    const now = Date.now();
    // Old answers go on every lookup, so ended tasks do not stay in memory.
    for (const [old, entry] of this.#lookups) if (now - entry.at >= LOOKUP_CACHE_MS) this.#lookups.delete(old);
    const cached = this.#lookups.get(key);
    if (cached) return cached.lookup;
    const lookup = this.#deps.hosting.mergeRequest(project, task.branch).then(
      (mergeRequest): MergeRequestLookup => (mergeRequest ? { kind: "found", mergeRequest } : { kind: "none" }),
      (err: unknown): MergeRequestLookup => {
        if (this.#lookups.get(key)?.lookup === lookup) this.#lookups.delete(key);
        return { kind: "unavailable", message: messageOf(err) };
      },
    );
    this.#lookups.set(key, { at: now, lookup });
    return lookup;
  }
}

/** A git error in the task's worktree as `repo_unavailable` with git's message. */
function asRepoUnavailable<T>(task: Task, work: Promise<T>): Promise<T> {
  return work.catch((err: unknown) => {
    throw new DomainError("repo_unavailable", `${task.branch}: ${messageOf(err)}`);
  });
}
