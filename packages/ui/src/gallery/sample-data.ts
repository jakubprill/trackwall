import type {
  CopilotUsage,
  FollowedMergeRequest,
  PipelineState,
  ProposedBy,
  Session,
  SessionList,
  Task,
  TaskOutcome,
  TaskProposal,
  TaskState,
  VerificationState,
} from "@trackwall/protocol";

/**
 * Builders of sample data for the gallery of view states: whole objects as the daemon sends them, with only what a state
 * needs given by the caller. Times count back from when the page loaded, so a waiting time reads "5 min" whenever the
 * gallery is opened. Sample data only: invented repos and prompts, nothing from a real workspace.
 */

const LOADED_AT = Date.now();

/** Never reached: the gallery shows views as they are and sends nothing to a daemon. */
export const NO_DAEMON = { baseUrl: "http://gallery.invalid" };

/** A repo name and a title longer than any column is wide. */
export const LONG_REPO = "customer-notification-preferences-service";
export const LONG_TITLE =
  "Move the notification preferences of every customer from the legacy settings table to the new preferences service";

/** An ISO time this many minutes before the page loaded. */
export function minutesAgo(minutes: number): string {
  return new Date(LOADED_AT - minutes * 60_000).toISOString();
}

/** A UUID that a number makes unique within the gallery, for sessions, tasks and proposals alike. */
export function sampleId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A running process group, the most common `run`. */
const RUNNING: Session["run"] = { kind: "running", runId: "run", startedAt: minutesAgo(90), pid: 4242 };

export const STOPPING: Session["run"] = { kind: "stopping", runId: "run", startedAt: minutesAgo(90), pid: 4242 };

export function exited(exitCode: number | null, stoppedByUser = false): Session["run"] {
  return {
    kind: "exited",
    runId: "run",
    startedAt: minutesAgo(90),
    endedAt: minutesAgo(10),
    exitCode,
    signal: null,
    stoppedByUser,
    lastLines: [],
  };
}

/** A state change from a hook; `medium` confidence makes it a guess (a hollow dot, ADR-261). */
export function stateOf(state: TaskState, confidence: "high" | "medium" = "high"): Session["state"] {
  return { state, source: "hook", confidence, at: minutesAgo(5), reason: "hook" };
}

/** What a conversation used: AI credits, a lower bound of them, premium requests or only tokens (a model of your own provider). */
export function usage(of: { credits?: number; partial?: boolean; premium?: number; tokens?: number }): CopilotUsage {
  return {
    modelCalls: 12,
    inputTokens: of.tokens ?? 48_000,
    outputTokens: 1_200,
    aiCredits: of.credits ?? null,
    aiCreditsPartial: of.partial ?? false,
    premiumRequests: of.premium ?? 0,
  };
}

export function session(n: number, of: Partial<Session> = {}): Session {
  return {
    id: sampleId(n),
    repo: "shop",
    supervisor: false,
    startedAt: minutesAgo(90),
    run: RUNNING,
    state: stateOf("Working"),
    windowTitle: null,
    needsAttention: false,
    waitingSince: null,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    readRequest: null,
    copyRequest: null,
    usage: null,
    model: null,
    modelInUse: null,
    modelError: null,
    tokenBudget: null,
    ...of,
  };
}

/** A session that waits for you since `minutes` ago, in `state`. */
export function waiting(n: number, minutes: number, of: Partial<Session> = {}): Session {
  return session(n, { state: stateOf("Input"), needsAttention: true, waitingSince: minutesAgo(minutes), ...of });
}

export function task(n: number, of: Partial<Task> = {}): Task {
  const repo = of.repo ?? "shop";
  return {
    id: sampleId(n),
    repo,
    prompt: "Add a discount to the cart for customers who order more than ten items",
    branch: `trackwall/task-${n}`,
    baseBranch: "main",
    base: COMMIT,
    worktree: `/projects/.trackwall/worktrees/${repo}/task-${n}`,
    createdAt: minutesAgo(120),
    title: null,
    proposedBy: null,
    model: null,
    approvals: "ask",
    plan: null,
    javaNavigation: false,
    sandbox: false,
    item: null,
    view: "terminal",
    summary: null,
    inReview: false,
    readyToClose: false,
    port: 41000 + n,
    included: { files: [], problems: [] },
    change: null,
    retryOf: null,
    paused: null,
    ...of,
  };
}

/** Who proposed a task or a proposal: a session, or the supervisor's session. */
export function proposedBy(session: number, supervisor = false): ProposedBy {
  return { session: sampleId(session), supervisor, task: null };
}

export function proposal(n: number, by: number, of: Partial<TaskProposal> = {}): TaskProposal {
  return {
    id: sampleId(n),
    kind: "task",
    repo: "shop",
    title: "Cover the discount rules with tests",
    prompt: "Write tests for the discount rules of the cart",
    model: null,
    approvals: "ask",
    item: null,
    parts: null,
    fromImpact: false,
    proposedBy: proposedBy(by),
    createdAt: minutesAgo(3),
    ...of,
  };
}

export function sessionList(of: Partial<SessionList>): SessionList {
  return { sessions: [], tasks: [], proposals: [], messages: [], lastSupervisor: null, sessionProfile: null, ...of };
}

/** A GitLab merge request, with its pipeline in `pipeline` (none when `null`). */
export function mergeRequest(number: number, state: FollowedMergeRequest["state"], pipeline: PipelineState | null): FollowedMergeRequest {
  return {
    number,
    title: "Add a discount to the cart",
    url: "https://gitlab.example.com/shop/shop/-/merge_requests/1",
    state,
    pipeline:
      pipeline === null
        ? null
        : {
            state: pipeline,
            url: "https://gitlab.example.com/shop/shop/-/pipelines/1",
            commit: COMMIT,
            failedJobs: pipeline === "failed" ? [{ name: "unit-tests", url: null, id: null }] : [],
          },
    project: { kind: "gitlab", host: "gitlab.example.com", path: "shop/shop" },
    pipelineFailedAt: null,
  };
}

export function outcome(
  taskNumber: number,
  of: { verification?: VerificationState; outdated?: boolean; mergeRequest?: FollowedMergeRequest },
): TaskOutcome {
  return {
    task: sampleId(taskNumber),
    repo: "shop",
    verification: of.verification ?? null,
    verificationOutdated: of.outdated ?? false,
    mergeRequest: of.mergeRequest ?? null,
  };
}
