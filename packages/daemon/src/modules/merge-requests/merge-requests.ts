import {
  type BranchOnRemote,
  type FailedJob,
  type FollowedMergeRequest,
  type HostedProject,
  type JobLog,
  type MergeRequest,
  type MergeRequestDraft,
  type MergeRequestForm,
  type MergeRequestLookup,
  PIPELINE_FIX_LOGS_MAX,
  type Pipeline,
  type PipelineFix,
  type PromptDelivery,
  type RepoHost,
  type Task,
  type TaskMergeRequest,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { ACTIVE_CHECK_MS, nextCheckMs, pipelineFailedNow, type WatchRead } from "./watch-schedule.ts";

/**
 * The `merge-requests` module (§4, §4.12, ADR-77): a finished task on its way to a merge request. The user pushes the
 * task branch from the task panel and opens the repo host's new merge request form with the title and description
 * they approved, and creates the merge request there; the panel then follows that merge request and its pipeline,
 * found by the task branch as its source branch. The daemon creates nothing on the repo host, so it needs no
 * permission there beyond what `gh` and `glab` already read with, and a merge request made any other way (by the
 * user, an agent, another MCP server) shows the same. It also follows every task's merge request in the background
 * (ADR-154): the Sessions list shows it, and a pipeline that fails is announced. On the user's request it reads the end
 * of a failed job's log, and hands the failed jobs' logs to the task's agent as a pipeline fix (ADR-195). Kept only in
 * memory: the repo host's last answers, and what it last read of each task.
 */

/** Repo host answers serve every panel and window for this long: the panel asks every half minute, and pipelines take minutes. */
const LOOKUP_CACHE_MS = 15_000;

/** How often the background watch looks for tasks due a read; each task has its own pace (`nextCheckMs`). */
const WATCH_TICK_MS = 15_000;
/** After a push, how long the watch reads every minute while the repo host still shows the pipeline from before it. */
const AFTER_PUSH_MS = 10 * 60_000;

/**
 * What the module needs from `agents`: the tasks, a task, its commits and uncommitted files, the squash of its round
 * commits (ADR-168), and a pipeline fix for its agent (ADR-195).
 */
interface MergeRequestTasks {
  tasks(): Task[];
  task(id: string): Task;
  /** A task, or `undefined` once it has ended. */
  findTask(id: string): Task | undefined;
  taskChangesSummary(id: string): Promise<{ commits: number; uncommitted: number }>;
  /** Runs `push` with the task's round commits squashed (`source`, `undefined` for none) and moves the branch there after it. */
  pushWithRoundsSquashed(id: string, push: (source: string | undefined) => Promise<void>): Promise<void>;
  /** Queues the user's pipeline fix for the task's agent and asks its session to read it. */
  askToFixPipeline(id: string, fix: PipelineFix): PromptDelivery;
}

/** What the module needs from `vcs`: the main remote as a project on a repo host, the task branch against it, and its push. */
interface MergeRequestVcs {
  hostedProject(dir: string, hosts: readonly RepoHost[]): Promise<HostedProject | null>;
  branchOnRemote(dir: string, branch: string, base: string): Promise<BranchOnRemote | null>;
  pushBranch(dir: string, branch: string, source?: string): Promise<void>;
}

/** What the module needs from the repo hosts in `vcs`: the merge request from a branch, the new merge request form, and a job's log. */
interface MergeRequestHosting {
  mergeRequest(project: HostedProject, branch: string): Promise<MergeRequest | null>;
  mergeRequestForm(project: HostedProject, form: MergeRequestForm): string;
  jobLog(project: HostedProject, job: string): Promise<{ raw: string; cut: boolean }>;
}

export interface MergeRequestsDeps {
  tasks: MergeRequestTasks;
  vcs: MergeRequestVcs;
  hosting: MergeRequestHosting;
  /** The repo hosts from the settings (`workspace`), to tell a GitLab remote from an unknown host. */
  repoHosts: () => RepoHost[];
  openUrl: (url: string) => void;
  /** The end of a job's log, cleaned and masked like a log line (`logs`, ADR-195); `cut` when the daemon did not read all of it. */
  jobLogExcerpt: (raw: string, cut: boolean) => Promise<Omit<JobLog, "job">>;
  /** The pipeline of a task's merge request failed since the read before (`pipelineFailedNow`). */
  onPipelineFailed: (task: Task, mergeRequest: MergeRequest) => void;
  log: (msg: string) => void;
}

interface WatchEntry {
  /** `null` when the branch had none; `undefined` before the repo host answered once since the daemon started. */
  followed: FollowedMergeRequest | null | undefined;
  /** When the watch reads it next (milliseconds since the epoch). */
  nextAt: number;
  /**
   * Set by a push: the commit of the pipeline shown before it, and until when. A repo host shows the new pipeline a
   * moment after the push, so reads stay at the active pace until it does, instead of the settled pace of the old one.
   */
  pushed?: { commit: string | null; until: number };
}

export class MergeRequests {
  readonly #deps: MergeRequestsDeps;
  /** The repo host's last answer per task; a failed one is not kept, so the next read asks again. */
  readonly #lookups = new Map<string, { at: number; lookup: Promise<MergeRequestLookup> }>();
  /** Tasks whose branch is being pushed: a second push at once is refused. */
  readonly #pushing = new Set<string>();
  /** What the watch and the panel last read of each task's merge request. */
  readonly #watched = new Map<string, WatchEntry>();
  #timer: NodeJS.Timeout | undefined;
  #checking: Promise<void> | undefined;
  /** The last failure the watch logged per task, so a worktree that stays unreadable is logged once, not every round. */
  readonly #logged = new Map<string, string>();

  constructor(deps: MergeRequestsDeps) {
    this.#deps = deps;
  }

  async get(id: string): Promise<TaskMergeRequest> {
    const task = this.#deps.tasks.task(id);
    const [changes, { onRemote, project }] = await Promise.all([this.#deps.tasks.taskChangesSummary(id), this.#branch(task)]);
    const push = onRemote && { ...onRemote, commits: changes.commits, uncommitted: changes.uncommitted };
    const now = Date.now();
    const lookup = project && push?.published ? await this.#lookup(task, project, now) : null;
    if (project && lookup) this.#recordLookup(id, project, lookup, now);
    return { task: id, push, project, lookup, targetBranch: task.baseBranch };
  }

  /** Reads every task's merge request at its own pace (`nextCheckMs`), the first read of each at once. */
  start(intervalMs = WATCH_TICK_MS): void {
    if (this.#timer) return;
    void this.checkWatched();
    this.#timer = setInterval(() => void this.checkWatched(), intervalMs);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One round of the watch: the tasks due a read (`now` and later), one after another, so a dozen tasks never start a
   * dozen `glab` at once; a round still running is the one a second call gets.
   */
  checkWatched(now = Date.now()): Promise<void> {
    this.#checking ??= this.#checkDue(now).finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  /** Every task's merge request as last read, by task, for the task outcomes (ADR-154). */
  followed(): Map<string, FollowedMergeRequest> {
    return new Map([...this.#watched].flatMap(([task, { followed }]) => (followed ? [[task, followed] as const] : [])));
  }

  async #checkDue(now: number): Promise<void> {
    const tasks = this.#deps.tasks.tasks();
    const listed = new Set(tasks.map((t) => t.id));
    for (const id of this.#watched.keys()) if (!listed.has(id)) this.#watched.delete(id);
    for (const id of this.#logged.keys()) if (!listed.has(id)) this.#logged.delete(id);
    for (const task of tasks) {
      if ((this.#watched.get(task.id)?.nextAt ?? 0) > now) continue;
      try {
        await this.#check(task, now);
        this.#logged.delete(task.id);
      } catch (err) {
        // A worktree git cannot read now (removed by hand, locked on Windows) is tried again at the settled pace.
        this.#record(task.id, { kind: "unknown" }, now);
        const message = `reading the merge request of ${task.branch} failed: ${messageOf(err)}`;
        if (this.#logged.get(task.id) !== message) this.#deps.log(message);
        this.#logged.set(task.id, message);
      }
    }
  }

  async #check(task: Task, now: number): Promise<void> {
    const { onRemote, project } = await this.#branch(task);
    if (!project) this.#record(task.id, { kind: "unknown" }, now);
    else if (!onRemote?.published) this.#record(task.id, { kind: "none" }, now);
    else this.#recordLookup(task.id, project, await this.#lookup(task, project, now), now);
  }

  /** The repo host's answer as a read of the watch: a host that did not answer leaves what was read before. */
  #recordLookup(id: string, project: HostedProject, lookup: MergeRequestLookup, now: number): void {
    if (lookup.kind === "found") this.#record(id, { kind: "found", mergeRequest: lookup.mergeRequest, project }, now);
    else this.#record(id, { kind: lookup.kind === "none" ? "none" : "unknown" }, now);
  }

  /** The task branch against the main remote, and that remote as a project on a repo host; only refs and config, no network. */
  async #branch(task: Task): Promise<{ onRemote: BranchOnRemote | null; project: HostedProject | null }> {
    const [onRemote, project] = await Promise.all([
      asRepoUnavailable(task, this.#deps.vcs.branchOnRemote(task.worktree, task.branch, task.base)),
      asRepoUnavailable(task, this.#deps.vcs.hostedProject(task.worktree, this.#deps.repoHosts())),
    ]);
    return { onRemote, project };
  }

  /** What a read found, with the next read's time; a pipeline that failed since the read before is announced once. */
  #record(id: string, read: WatchRead, now: number): void {
    const entry = this.#watched.get(id);
    const before = entry?.followed;
    const pushed = stillAfterPush(entry?.pushed, read, now);
    const nextAt = now + (pushed ? ACTIVE_CHECK_MS : nextCheckMs(read));
    if (read.kind === "unknown") {
      this.#watched.set(id, { followed: before, nextAt, pushed });
      return;
    }
    if (read.kind === "none") {
      this.#watched.set(id, { followed: null, nextAt, pushed });
      return;
    }
    const { mergeRequest, project } = read;
    const failedNow = pipelineFailedNow(before, mergeRequest);
    const stillFailed = mergeRequest.pipeline?.state === "failed" ? (before?.pipelineFailedAt ?? null) : null;
    const pipelineFailedAt = failedNow ? new Date(now).toISOString() : stillFailed;
    this.#watched.set(id, { followed: { ...mergeRequest, project, pipelineFailedAt }, nextAt, pushed });
    const task = this.#deps.tasks.findTask(id);
    if (!failedNow || !task) return;
    // The announcement must not undo the read: a proposer's queue that fails to save is logged, and the outcome stands.
    try {
      this.#deps.onPipelineFailed(task, mergeRequest);
    } catch (err) {
      this.#deps.log(`telling the proposer of ${task.branch} about its failed pipeline failed: ${messageOf(err)}`);
    }
  }

  /**
   * Pushes the task branch at the user's request, its round commits squashed first (ADR-168): never forced, refused while it
   * has no commits or a remote on no known repo host.
   */
  async push(id: string): Promise<TaskMergeRequest> {
    const task = this.#deps.tasks.task(id);
    if (this.#pushing.has(id)) throw new DomainError("bad_request", `branch ${task.branch} is already being pushed`);
    this.#pushing.add(id);
    try {
      const [{ commits }, project] = await Promise.all([
        this.#deps.tasks.taskChangesSummary(id),
        asRepoUnavailable(task, this.#deps.vcs.hostedProject(task.worktree, this.#deps.repoHosts())),
      ]);
      if (commits === 0)
        throw new DomainError("bad_request", `branch ${task.branch} has no commits yet; ask the agent to commit its changes`);
      // Only to a repo host the user named (or GitHub), the one the panel shows: never to a path or host the agent set.
      if (!project) throw unknownHost(task);
      // The round commits go only as part of the commit after them: the merge request shows the agent's commits.
      await this.#deps.tasks.pushWithRoundsSquashed(id, (source) =>
        asRepoUnavailable(task, this.#deps.vcs.pushBranch(task.worktree, task.branch, source)),
      );
    } finally {
      this.#pushing.delete(id);
      this.#lookups.delete(id);
      // A push starts a pipeline: the watch reads the branch in its next round, and every minute until the new one shows.
      const followed = this.#watched.get(id)?.followed;
      const pushed = { commit: followed?.pipeline?.commit ?? null, until: Date.now() + AFTER_PUSH_MS };
      this.#watched.set(id, { followed, nextAt: 0, pushed });
    }
    return this.get(id);
  }

  /**
   * Opens the repo host's form for a merge request from the task branch with the draft the user approved, on the desktop.
   */
  async openForm(draft: MergeRequestDraft): Promise<void> {
    this.#deps.openUrl(await this.formUrl(draft));
  }

  /**
   * The address of the repo host's form for a merge request from the task branch with the draft the user approved, for a
   * page that opens it itself when the daemon has no desktop (ADR-120). Refused when the form would not show what the user
   * reviewed (commits not pushed yet) or would make a second open merge request.
   */
  async formUrl(draft: MergeRequestDraft): Promise<string> {
    const task = this.#deps.tasks.task(draft.task);
    const state = await this.get(draft.task);
    if (!state.project) throw unknownHost(task);
    if (!state.push?.published || state.push.unpushed > 0)
      throw new DomainError("bad_request", `push branch ${task.branch} first, so the merge request has every commit`);
    if (state.lookup?.kind === "found" && state.lookup.mergeRequest.state === "open")
      throw new DomainError("bad_request", `branch ${task.branch} already has an open merge request: ${state.lookup.mergeRequest.url}`);
    const { title, description } = draft;
    return this.#deps.hosting.mergeRequestForm(state.project, { source: task.branch, target: state.targetBranch, title, description });
  }

  /** The end of the log of a job that failed the pipeline of the task's open merge request (ADR-195). */
  async jobLog(id: string, job: string): Promise<JobLog> {
    const { project, pipeline } = await this.#failedPipeline(id);
    const failed = pipeline.failedJobs.find((j) => j.id === job);
    if (!failed) throw new DomainError("not_found", `job ${job} is not one that failed the pipeline ${pipeline.url}`);
    if (!hasLog(failed)) throw new DomainError("not_found", `job ${job} has no log Trackwall can read`);
    return this.#readJobLog(project, failed);
  }

  /**
   * The user's request to the task's agent to fix the failed pipeline of its open merge request (ADR-195): the end of the
   * logs of the first `PIPELINE_FIX_LOGS_MAX` failed jobs that have one, the others by name, also a job whose log the
   * repo host did not give (gone past its retention, a timeout): the agent still gets the rest.
   */
  async fixPipeline(id: string): Promise<{ delivery: PromptDelivery }> {
    const { project, pipeline } = await this.#failedPipeline(id);
    const readable = pipeline.failedJobs.filter(hasLog).slice(0, PIPELINE_FIX_LOGS_MAX);
    const reads = await Promise.allSettled(readable.map((job) => this.#readJobLog(project, job)));
    const logs = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
    const read = new Set(logs.map((log) => log.job));
    const otherJobs = pipeline.failedJobs.filter((job) => !read.has(job)).map((job) => job.name);
    const fix = { pipeline: pipeline.url, commit: pipeline.commit, logs, otherJobs };
    return { delivery: this.#deps.tasks.askToFixPipeline(id, fix) };
  }

  /** The task's open merge request whose pipeline failed, as the repo host shows it now (or within `LOOKUP_CACHE_MS`). */
  async #failedPipeline(id: string): Promise<{ project: HostedProject; pipeline: Pipeline }> {
    const task = this.#deps.tasks.task(id);
    const { onRemote, project } = await this.#branch(task);
    if (!project) throw unknownHost(task);
    if (!onRemote?.published) throw new DomainError("bad_request", `branch ${task.branch} is not pushed, so it has no pipeline`);
    const now = Date.now();
    const lookup = await this.#lookup(task, project, now);
    this.#recordLookup(id, project, lookup, now);
    if (lookup.kind === "unavailable") throw new DomainError("bad_request", `cannot read the merge request: ${lookup.message}`);
    const mergeRequest = lookup.kind === "found" ? lookup.mergeRequest : null;
    if (mergeRequest?.state !== "open" || mergeRequest.pipeline?.state !== "failed")
      throw new DomainError("bad_request", `branch ${task.branch} has no open merge request whose pipeline failed`);
    return { project, pipeline: mergeRequest.pipeline };
  }

  async #readJobLog(project: HostedProject, job: JobWithLog): Promise<JobLog> {
    const { raw, cut } = await this.#deps.hosting.jobLog(project, job.id).catch((err: unknown) => {
      throw new DomainError("bad_request", `cannot read the log of job ${job.name}: ${messageOf(err)}`);
    });
    return { job, ...(await this.#deps.jobLogExcerpt(raw, cut)) };
  }

  /** The repo host's answer, shared for `LOOKUP_CACHE_MS` by the panel and the watch; a pure read, which callers record. */
  #lookup(task: Task, project: HostedProject, now: number): Promise<MergeRequestLookup> {
    const key = task.id;
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

type JobWithLog = FailedJob & { id: string };

/** A GitLab or GitHub Actions job, whose log the daemon can read (ADR-195). */
function hasLog(job: FailedJob): job is JobWithLog {
  return job.id !== null;
}

/** A push's fast pace lasts until the repo host shows a pipeline on another commit than before it, or until it runs out. */
function stillAfterPush(pushed: WatchEntry["pushed"], read: WatchRead, now: number): WatchEntry["pushed"] {
  if (!pushed || now >= pushed.until) return undefined;
  const commit = read.kind === "found" ? read.mergeRequest.pipeline?.commit : undefined;
  return commit !== undefined && commit !== pushed.commit ? undefined : pushed;
}

function unknownHost(task: Task): DomainError {
  return new DomainError(
    "bad_request",
    `the main remote of ${task.repo} is not on GitHub or on a repo host from the settings; add its repo host in Settings`,
  );
}

/** A git error in the task's worktree as `repo_unavailable` with git's message. */
function asRepoUnavailable<T>(task: Task, work: Promise<T>): Promise<T> {
  return work.catch((err: unknown) => {
    throw new DomainError("repo_unavailable", `${task.branch}: ${messageOf(err)}`);
  });
}
