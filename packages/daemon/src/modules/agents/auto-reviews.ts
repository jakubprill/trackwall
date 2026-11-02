import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_REVIEW_DIFF_MAX_BYTES,
  AUTO_REVIEW_TEXT_MAX,
  AutoReview,
  type AutoReviewSettings,
  type AutoReviewTrigger,
  withoutInvisibleCharacters,
} from "@trackwall/protocol";
import { z } from "zod";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { FollowedStateFile } from "../../infra/state-file.ts";
import { cutText, reviewFindings } from "./auto-review-findings.ts";
import { type ReviewOutcome, type ReviewRunProcs, reviewerArgs, runReview } from "./auto-review-run.ts";

/**
 * Automatic reviews of tasks (§4.4, ADR-182): Copilot CLI's `/review` on a task's changes, one at a time per task, run
 * by `auto-review-run.ts` with only the tools that read. The diff goes to the reviewer as a file the daemon writes
 * (`changes.diff` in `auto-reviews/<task>/` of the state directory), since the reviewer has no shell for git; the
 * findings come from its answer (`auto-review-findings.ts`). The result is for the user, who turns findings into review
 * comments in the "Changes" tab: nothing reaches the task's agent from here. The last review of every task is kept
 * across a daemon restart in `auto-reviews.json`, like the verifications (ADR-115).
 */

export const AUTO_REVIEWS_FILE = "auto-reviews.json";
/** The folder of the diff files in the state directory, one folder per running review, removed when it ends. */
const AUTO_REVIEWS_DIR = "auto-reviews";
const DIFF_FILE = "changes.diff";

const StoredAutoReviews = z.object({ reviews: z.array(AutoReview) });
type StoredAutoReviews = z.infer<typeof StoredAutoReviews>;

const STOPPED_WITH_DAEMON = "Trackwall stopped during the review; review again";
const CANCELLED = "Stopped before the reviewer finished";

/** What the reviews need of a task: its repo and worktree (`not_found` for an unknown or ended task) and its changes. */
interface AutoReviewTasks {
  task(id: string): { repo: string; worktree: string };
  findTask(id: string): unknown;
  /** The task's changes against its base commit, the diff cut within `maxPatchBytes`. */
  changes(id: string, maxPatchBytes: number): Promise<{ files: readonly unknown[]; patch: string; truncated: boolean }>;
}

/** What a review starts with: Copilot CLI and the environment a session of the task would get (ADR-93, ADR-136). */
interface ReviewerLaunch {
  program: string;
  prefix: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The task session's mise arguments (`--secret-env-vars`). */
  args: readonly string[];
  secrets: readonly string[];
}

export interface AutoReviewsDeps {
  tasks: AutoReviewTasks;
  /** `agent_unavailable` without Copilot CLI. */
  launch: (place: { repo: string; task: string }) => Promise<ReviewerLaunch>;
  procs: ReviewRunProcs & { stop(owner: string): Promise<unknown> };
  /** `autoReview` from `workspace.yaml`; `invalid_config` for a bad key. */
  settings: () => AutoReviewSettings;
  /** The state directory. */
  home: string;
  log: (msg: string) => void;
  /** Overrides how long a review may take (tests). */
  limitMs?: number;
}

interface Entry {
  /** Replaced, never changed in place, so a caller holds one moment of it. */
  review: AutoReview;
  done: Promise<void>;
  cancelled: boolean;
}

/** The reviewer's process group in `procs`; only ever built. */
function reviewOwner(task: string): string {
  return `auto-review:${task}`;
}

export class AutoReviews {
  readonly #deps: AutoReviewsDeps;
  readonly #byTask = new Map<string, Entry>();
  /** A start in progress per task: two clicks, or a click and a report, give one review. */
  readonly #starting = new Map<string, Promise<AutoReview | null>>();
  readonly #file: FollowedStateFile<StoredAutoReviews>;

  constructor(deps: AutoReviewsDeps) {
    this.#deps = deps;
    const path = join(deps.home, AUTO_REVIEWS_FILE);
    this.#file = new FollowedStateFile(path, StoredAutoReviews, {
      broken: (problem, aside) => deps.log(`${path}: ${problem}; file moved to ${aside}, the tasks start without automatic reviews`),
      log: deps.log,
    });
    this.#restore();
    // A folder left by a daemon that crashed during a review.
    rmSync(join(deps.home, AUTO_REVIEWS_DIR), { recursive: true, force: true });
  }

  /** The user's review of a task's changes, or the one running. */
  async start(task: string): Promise<AutoReview> {
    const review = await this.#startOnce(task, "user");
    if (review === null) throw new Error(`the review of task ${task} did not start`);
    return review;
  }

  /**
   * The task's agent reported its result: with `autoReview.afterReport` on, its changes get a review, unless one runs or
   * the last one saw the same diff. It runs in the background; a refusal (no changes, no Copilot CLI) is only logged.
   */
  afterReport(task: string): void {
    let settings: AutoReviewSettings;
    try {
      settings = this.#deps.settings();
    } catch (err) {
      this.#deps.log(`automatic review of task ${task} skipped: ${messageOf(err)}`);
      return;
    }
    if (!settings.afterReport) return;
    this.#startOnce(task, "report").catch((err: unknown) => this.#deps.log(`automatic review of task ${task}: ${messageOf(err)}`));
  }

  /** The task's last review; `null` when there was none or the task has ended. */
  get(task: string): AutoReview | null {
    if (!this.#deps.tasks.findTask(task)) return null;
    return this.#byTask.get(task)?.review ?? null;
  }

  /** Stops the running review; it ends `cancelled`. A finished one is returned as it is. */
  async cancel(task: string): Promise<AutoReview | null> {
    const entry = this.#byTask.get(task);
    if (entry?.review.state === "running") {
      entry.cancelled = true;
      await this.#deps.procs.stop(reviewOwner(task));
      await entry.done;
    }
    return this.get(task);
  }

  /** An ended task keeps no review: stopped if it runs, and forgotten in memory and in the file. */
  async forget(task: string): Promise<void> {
    await this.cancel(task);
    this.#byTask.delete(task);
    this.#follow();
  }

  /**
   * Daemon exit, before `procs.stopAll`: the file keeps the reviews of this moment, a running one as cancelled now,
   * since the stop ends its reviewer.
   */
  keepForRestart(): void {
    const now = new Date().toISOString();
    this.#file.follow({
      reviews: [...this.#byTask.values()].map(({ review }) => (review.state === "running" ? stoppedWithDaemon(review, now) : review)),
    });
    this.#file.stopFollowing();
  }

  #startOnce(task: string, trigger: AutoReviewTrigger): Promise<AutoReview | null> {
    const running = this.#byTask.get(task)?.review;
    if (running?.state === "running") return Promise.resolve(running);
    const starting = this.#starting.get(task) ?? this.#start(task, trigger).finally(() => this.#starting.delete(task));
    this.#starting.set(task, starting);
    return starting;
  }

  async #start(task: string, trigger: AutoReviewTrigger): Promise<AutoReview | null> {
    const { repo, worktree } = this.#deps.tasks.task(task);
    const changes = await this.#deps.tasks.changes(task, AUTO_REVIEW_DIFF_MAX_BYTES);
    if (changes.files.length === 0) throw new DomainError("bad_request", `task ${task} has no changes to review`);
    const diffHash = createHash("sha256").update(changes.patch).digest("hex");
    if (trigger === "report" && this.#byTask.get(task)?.review.diffHash === diffHash) return null;
    const launch = await this.#deps.launch({ repo, task });
    const dir = join(this.#deps.home, AUTO_REVIEWS_DIR, task);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const diffFile = join(dir, DIFF_FILE);
    writeFileSync(diffFile, changes.patch);
    const entry: Entry = {
      review: {
        task,
        repo,
        state: "running",
        trigger,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        diffHash,
        diffTruncated: changes.truncated,
        findings: [],
        text: "",
        message: null,
      },
      done: Promise.resolve(),
      cancelled: false,
    };
    const run = runReview(
      {
        owner: reviewOwner(task),
        command: [launch.program, ...launch.prefix, ...reviewerArgs(dir), ...launch.args],
        cwd: worktree,
        env: launch.env,
        secrets: launch.secrets,
        prompt: reviewPrompt(diffFile, changes.truncated),
        limitMs: this.#deps.limitMs,
      },
      this.#deps.procs,
      this.#deps.log,
    );
    this.#byTask.set(task, entry);
    this.#follow();
    entry.done = this.#finish(entry, run, worktree, dir);
    return entry.review;
  }

  /** The review's end once its reviewer has stopped and the diff's folder is gone, so a finished review leaves nothing behind. */
  async #finish(entry: Entry, run: Promise<ReviewOutcome>, worktree: string, dir: string): Promise<void> {
    const { task } = entry.review;
    let end: Partial<AutoReview>;
    try {
      const { answer, refused } = await run;
      end = { state: "done", findings: reviewFindings(answer, worktree), text: kept(answer), message: refusedMessage(refused) };
    } catch (err) {
      if (!entry.cancelled) this.#deps.log(`automatic review of task ${task}: ${messageOf(err)}`);
      end = entry.cancelled ? { state: "cancelled", message: CANCELLED } : { state: "failed", message: messageOf(err) };
    }
    await this.#deps.procs
      .stop(reviewOwner(task))
      .catch((err: unknown) => this.#deps.log(`automatic review of task ${task}: ${messageOf(err)}`));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`automatic review of task ${task}: the diff's folder stays: ${messageOf(err)}`);
    }
    this.#settle(entry, end);
  }

  #settle(entry: Entry, end: Partial<AutoReview>): void {
    entry.review = { ...entry.review, ...end, finishedAt: new Date().toISOString() };
    this.#follow();
  }

  /** Daemon start: the reviews the previous daemon left, of the tasks still there; a running one ended with it. */
  #restore(): void {
    for (const review of this.#file.read()?.reviews ?? []) {
      if (!this.#deps.tasks.findTask(review.task)) continue;
      const restored = review.state === "running" ? stoppedWithDaemon(review, null) : review;
      this.#byTask.set(review.task, { review: restored, done: Promise.resolve(), cancelled: false });
    }
  }

  #follow(): void {
    this.#file.follow({ reviews: [...this.#byTask.values()].map((entry) => entry.review) });
  }
}

/**
 * The one prompt of a review: Copilot CLI's `/review` with the daemon's instructions after it, which Copilot CLI passes
 * on as "Additional instructions". Its review agent would read the changes with git in a shell, which the reviewer does
 * not have, so the diff is a file; the issues are to come back in the review agent's own format, which the daemon reads.
 */
function reviewPrompt(diffFile: string, truncated: boolean): string {
  return [
    "/review",
    `The changes to review are this branch's work against its base commit, committed and uncommitted, as one unified diff in the file \`${diffFile}\`.`,
    truncated ? "The diff is cut at its end; say which files you could not review." : "",
    "There is no shell and no git: read the diff with the view tool and the files around it with view, grep and glob, and tell the review agent so.",
    "In your answer, repeat each issue the review agent found word for word in its format: a heading `## Issue: <title>`, then **File:** with the path and the line number in the current file, **Severity:**, **Problem:** and **Suggested fix:**.",
  ]
    .filter((line) => line !== "")
    .join(" ");
}

/** What the reviewer asked for and did not get, so the user knows the review may have stopped short; `null` for nothing. */
function refusedMessage(refused: readonly string[]): string | null {
  if (refused.length === 0) return null;
  return cutText(`The reviewer asked for more than reading the task and was refused: ${[...new Set(refused)].join("; ")}`, 500);
}

function stoppedWithDaemon(review: AutoReview, finishedAt: string | null): AutoReview {
  return { ...review, state: "cancelled", finishedAt, message: STOPPED_WITH_DAEMON };
}

/** The answer as the review keeps it: without invisible characters, cut at `AUTO_REVIEW_TEXT_MAX`. */
function kept(answer: string): string {
  return cutText(withoutInvisibleCharacters(answer).trim(), AUTO_REVIEW_TEXT_MAX);
}
