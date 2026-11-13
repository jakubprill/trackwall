import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AUTO_REVIEW_DIFF_MAX_BYTES,
  AUTO_REVIEW_TEXT_MAX,
  AutoReview,
  AutoReviewKind,
  type AutoReviewSettings,
  type AutoReviewTrigger,
  countLabel,
  cutText,
  type FreshAutoReview,
  withoutInvisibleCharacters,
} from "@trackwall/protocol";
import { z } from "zod";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { FollowedStateFile, stateFormat } from "../../infra/state-file.ts";
import { reviewFindings } from "./auto-review-findings.ts";
import { reviewPrompt } from "./auto-review-prompts.ts";
import { KIND_TOOLS, type ReviewOutcome, type ReviewRunProcs, reviewerArgs, runReview } from "./auto-review-run.ts";
import { type RepoRules, RULE_FILES_MAX, RULE_PLACES } from "./repo-rules.ts";

/**
 * Automatic reviews of tasks (§4.4, ADR-182, ADR-234): Copilot CLI's `/review` on a task's changes (`code`), or a check
 * of them against the repo's rules (`rules`), one of each kind at a time per task, run by `auto-review-run.ts` with only
 * the tools that read. The diff goes to the reviewer as a file the daemon writes (`changes.diff` in
 * `auto-reviews/<kind>/<task>/` of the state directory), since the reviewer has no shell for git, and so do the rule
 * files of the task's base commit (`rules/` beside it); the findings come from its answer (`auto-review-findings.ts`).
 * The result is for the user, who turns findings into review comments in the "Changes" tab: nothing reaches the task's
 * agent from here. The last review of each kind of every task is kept across a daemon restart in `auto-reviews.json`,
 * like the verifications (ADR-115).
 */

export const AUTO_REVIEWS_FILE = "auto-reviews.json";
/** The folder of the diff files in the state directory, one folder per running review, removed when it ends. */
const AUTO_REVIEWS_DIR = "auto-reviews";
const DIFF_FILE = "changes.diff";
/** The folder of the rule files' copies beside the diff. */
const RULES_DIR = "rules";

const StoredAutoReviews = z.object({ reviews: z.array(AutoReview) });
type StoredAutoReviews = z.infer<typeof StoredAutoReviews>;
/** `auto-reviews.json` (ADR-182, ADR-223). */
export const AUTO_REVIEWS_FORMAT = stateFormat(StoredAutoReviews);

/** The review's `diffHash`: what tells the diff it saw from the task's diff now. */
function diffHashOf(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

const STOPPED_WITH_DAEMON = "Trackwall stopped during the review; review again";
const CANCELLED = "Stopped before the reviewer finished";

/**
 * What the reviews need of a task: its repo and worktree (`not_found` for an unknown or ended task), its changes and
 * the repo's rules for them.
 */
interface AutoReviewTasks {
  task(id: string): { repo: string; worktree: string };
  hasTask(id: string): boolean;
  /** The task's changes against its base commit: the changed files' paths, and the diff cut within `maxPatchBytes`. */
  changes(id: string, maxPatchBytes: number): Promise<{ paths: string[]; patch: string; truncated: boolean }>;
  /** The repo's rule files for a change of `changed`, from the task's base commit (`repo-rules.ts`). */
  rules(id: string, changed: readonly string[]): Promise<RepoRules>;
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
  /** Rule files a rules check had to leave out, which its message names when it ends. */
  omittedRules: number;
}

const KINDS = AutoReviewKind.options;

/** The reviewer's process group in `procs`; only ever built. */
function reviewOwner(task: string, kind: AutoReviewKind): string {
  return `auto-review:${kind}:${task}`;
}

/** Where a review and its entries are kept: one per kind and task. */
function reviewKey(task: string, kind: AutoReviewKind): string {
  return `${kind}:${task}`;
}

export class AutoReviews {
  readonly #deps: AutoReviewsDeps;
  /** By `reviewKey`. */
  readonly #reviews = new Map<string, Entry>();
  /** A start in progress per kind and task: two clicks, or a click and a report, give one review. */
  readonly #starting = new Map<string, Promise<AutoReview | null>>();
  readonly #file: FollowedStateFile<StoredAutoReviews>;

  constructor(deps: AutoReviewsDeps) {
    this.#deps = deps;
    const path = join(deps.home, AUTO_REVIEWS_FILE);
    this.#file = new FollowedStateFile(path, AUTO_REVIEWS_FORMAT, {
      broken: (problem, aside) => deps.log(`${path}: ${problem}; file moved to ${aside}, the tasks start without automatic reviews`),
      log: deps.log,
    });
    this.#restore();
    // A folder left by a daemon that crashed during a review.
    rmSync(join(deps.home, AUTO_REVIEWS_DIR), { recursive: true, force: true });
  }

  /** The user's review of a task's changes, or the one of the kind running. */
  async start(task: string, kind: AutoReviewKind): Promise<AutoReview> {
    // A start the agent's report began may give way for an unchanged diff; the user's click reviews it anyway.
    const review = (await this.#startOnce(task, kind, "user")) ?? (await this.#startOnce(task, kind, "user"));
    if (review === null) throw new Error(`the ${kind} review of task ${task} did not start`);
    return review;
  }

  /**
   * The task's agent reported its result: each kind turned on in `autoReview` (`afterReport`, `rulesAfterReport`) reviews
   * its changes, unless one of the kind runs or the last one saw the same diff. They run in the background; a refusal (no
   * changes, no rules, no Copilot CLI) is only logged.
   */
  afterReport(task: string): void {
    let settings: AutoReviewSettings;
    try {
      settings = this.#deps.settings();
    } catch (err) {
      this.#deps.log(`automatic review of task ${task} skipped: ${messageOf(err)}`);
      return;
    }
    const on: Record<AutoReviewKind, boolean> = { code: settings.afterReport, rules: settings.rulesAfterReport };
    for (const kind of KINDS)
      if (on[kind])
        this.#startOnce(task, kind, "report").catch((err: unknown) =>
          this.#deps.log(`automatic ${kind} review of task ${task}: ${messageOf(err)}`),
        );
  }

  /** The task's last review of the kind; `null` when there was none or the task has ended. */
  get(task: string, kind: AutoReviewKind): AutoReview | null {
    if (!this.#deps.tasks.hasTask(task)) return null;
    return this.#reviews.get(reviewKey(task, kind))?.review ?? null;
  }

  /**
   * The task's last finished review of the kind, and whether the task's diff differs from the one it saw (ADR-238);
   * `null` without one. A running, failed or cancelled review says nothing about the changes.
   */
  async withFreshness(task: string, kind: AutoReviewKind): Promise<FreshAutoReview | null> {
    const review = this.get(task, kind);
    if (review?.state !== "done") return null;
    const changes = await this.#deps.tasks.changes(task, AUTO_REVIEW_DIFF_MAX_BYTES);
    return { review, outdated: diffHashOf(changes.patch) !== review.diffHash };
  }

  /** Stops the running review of the kind; it ends `cancelled`. A finished one is returned as it is. */
  async cancel(task: string, kind: AutoReviewKind): Promise<AutoReview | null> {
    await this.#stopKind(task, kind);
    return this.get(task, kind);
  }

  /**
   * Stops the task's reviews that are starting or running, so nothing of Trackwall runs in its worktree any more; `null`
   * right away when there is none, so ending a task without a review does not wait a turn.
   */
  stop(task: string): Promise<void> | null {
    const stops = KINDS.map((kind) => this.#stopKind(task, kind)).filter((stop) => stop !== null);
    return stops.length === 0 ? null : Promise.all(stops).then(() => undefined);
  }

  /** An ended task keeps no review, in memory or in the file; its reviews were stopped before (`stop`). */
  forget(task: string): void {
    for (const kind of KINDS) this.#reviews.delete(reviewKey(task, kind));
    this.#follow();
  }

  /**
   * Daemon exit, before `procs.stopAll`: the file keeps the reviews of this moment, a running one as cancelled now,
   * since the stop ends its reviewer.
   */
  keepForRestart(): void {
    const now = new Date().toISOString();
    this.#file.follow({
      reviews: [...this.#reviews.values()].map(({ review }) => (review.state === "running" ? stoppedWithDaemon(review, now) : review)),
    });
    this.#file.stopFollowing();
  }

  #stopKind(task: string, kind: AutoReviewKind): Promise<void> | null {
    const key = reviewKey(task, kind);
    const starting = this.#starting.get(key);
    if (starting === undefined && this.#reviews.get(key)?.review.state !== "running") return null;
    return (async () => {
      await starting?.catch(() => null);
      const entry = this.#reviews.get(key);
      if (entry?.review.state !== "running") return;
      entry.cancelled = true;
      await this.#deps.procs.stop(reviewOwner(task, kind));
      await entry.done;
    })();
  }

  #startOnce(task: string, kind: AutoReviewKind, trigger: AutoReviewTrigger): Promise<AutoReview | null> {
    const key = reviewKey(task, kind);
    const running = this.#reviews.get(key)?.review;
    if (running?.state === "running") return Promise.resolve(running);
    const starting = this.#starting.get(key) ?? this.#start(task, kind, trigger).finally(() => this.#starting.delete(key));
    this.#starting.set(key, starting);
    return starting;
  }

  async #start(task: string, kind: AutoReviewKind, trigger: AutoReviewTrigger): Promise<AutoReview | null> {
    const { repo, worktree } = this.#deps.tasks.task(task);
    const changes = await this.#deps.tasks.changes(task, AUTO_REVIEW_DIFF_MAX_BYTES);
    if (changes.paths.length === 0) {
      // The agent reports on tasks without changes too; only the user's click is told.
      if (trigger === "report") return null;
      throw new DomainError("bad_request", `task ${task} has no changes to review`);
    }
    const diffHash = diffHashOf(changes.patch);
    const key = reviewKey(task, kind);
    const last = this.#reviews.get(key)?.review;
    // Only a review that finished saw the diff; one that failed or was stopped is tried again.
    if (trigger === "report" && last?.state === "done" && last.diffHash === diffHash) return null;
    const rules = kind === "rules" ? await this.#rules(task, changes.paths) : null;
    const launch = await this.#deps.launch({ repo, task });
    const dir = join(this.#deps.home, AUTO_REVIEWS_DIR, kind, task);
    const diffFile = join(dir, DIFF_FILE);
    const ruleFiles = writeReviewDir(dir, changes.patch, rules?.files ?? new Map(), (msg) =>
      this.#deps.log(`automatic rules review of task ${task}: ${msg}`),
    );
    const entry: Entry = {
      review: {
        task,
        repo,
        kind,
        state: "running",
        trigger,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        diffHash,
        diffTruncated: changes.truncated,
        findings: [],
        text: "",
        message: null,
        ruleFiles,
      },
      done: Promise.resolve(),
      cancelled: false,
      omittedRules: (rules?.omitted ?? 0) + (rules?.files.size ?? 0) - ruleFiles.length,
    };
    const run = runReview(
      {
        owner: reviewOwner(task, kind),
        command: [launch.program, ...launch.prefix, ...reviewerArgs(KIND_TOOLS[kind]), ...launch.args],
        cwd: worktree,
        reviewDir: dir,
        env: launch.env,
        secrets: launch.secrets,
        prompt: reviewPrompt(
          rules === null
            ? { kind: "code", diffFile, truncated: changes.truncated }
            : { kind: "rules", diffFile, truncated: changes.truncated, rules: { dir: join(dir, RULES_DIR), files: ruleFiles } },
        ),
        limitMs: this.#deps.limitMs,
      },
      this.#deps.procs,
      this.#deps.log,
    );
    this.#reviews.set(key, entry);
    this.#follow();
    entry.done = this.#finish(entry, run, worktree, dir);
    return entry.review;
  }

  /** The repo's rules for a rules check of task `task`; `bad_request` for a repo without any, which the report only logs. */
  async #rules(task: string, changed: readonly string[]): Promise<RepoRules> {
    const rules = await this.#deps.tasks.rules(task, changed);
    if (rules.files.size === 0)
      throw new DomainError(
        "bad_request",
        `the repo of task ${task} has no rules for agents at the task's base commit: none of ${RULE_PLACES}`,
      );
    return rules;
  }

  /** The review's end once its reviewer has stopped and its folder is gone, so a finished review leaves nothing behind. */
  async #finish(entry: Entry, run: Promise<ReviewOutcome>, worktree: string, dir: string): Promise<void> {
    const { task, kind } = entry.review;
    const name = `automatic ${kind} review of task ${task}`;
    let end: Partial<AutoReview>;
    try {
      const { answer, refused } = await run;
      end = answeredEnd(reviewFindings(answer, worktreePaths(worktree)), kept(answer), refused, entry.omittedRules);
      if (end.state === "failed") this.#deps.log(`${name}: ${end.message}`);
    } catch (err) {
      if (!entry.cancelled) this.#deps.log(`${name}: ${messageOf(err)}`);
      end = entry.cancelled ? { state: "cancelled", message: CANCELLED } : { state: "failed", message: messageOf(err) };
    }
    await this.#deps.procs.stop(reviewOwner(task, kind)).catch((err: unknown) => this.#deps.log(`${name}: ${messageOf(err)}`));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`${name}: the review's folder stays: ${messageOf(err)}`);
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
      if (!this.#deps.tasks.hasTask(review.task)) continue;
      const restored = review.state === "running" ? stoppedWithDaemon(review, null) : review;
      this.#reviews.set(reviewKey(review.task, review.kind), {
        review: restored,
        done: Promise.resolve(),
        cancelled: false,
        omittedRules: 0,
      });
    }
  }

  #follow(): void {
    this.#file.follow({ reviews: [...this.#reviews.values()].map((entry) => entry.review) });
  }
}

/**
 * A review's folder: the diff, and the rule files under `rules/` at their paths in the repo. Returns the rule files
 * written, in their order; a rule file whose path this system cannot hold is left out rather than failing the review.
 */
function writeReviewDir(dir: string, patch: string, rules: RepoRules["files"], log: (msg: string) => void): string[] {
  const written: string[] = [];
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DIFF_FILE), patch);
    for (const [path, content] of rules) {
      const file = join(dir, RULES_DIR, ...path.split("/"));
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        written.push(path);
      } catch (err) {
        // A name Windows does not allow (`:`, a reserved name) cannot be a rule the reviewer reads; the review says so.
        log(`rule file ${path} left out: ${messageOf(err)}`);
      }
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return written;
}

/** Rule files a rules check did not get, past its limits or unwritable here; `null` for none. */
function omittedMessage(omitted: number): string | null {
  if (omitted <= 0) return null;
  return `${countLabel(omitted, { one: "rule file was", other: "rule files were" })} left out (a check takes at most ${RULE_FILES_MAX} files and 1 MiB of them, and a name this system cannot hold is skipped)`;
}

function joinedMessage(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part) => part !== null);
  return present.length === 0 ? null : present.join(". ");
}

/**
 * How a review whose turn ended settles: `done` with its findings, or `failed` when the reviewer was refused something
 * and found nothing, since it may never have read the change and "no findings" would read as a clean change.
 */
function answeredEnd(
  findings: AutoReview["findings"],
  text: string,
  refused: readonly string[],
  omittedRules: number,
): Partial<AutoReview> {
  const refusals = [...new Set(refused)].join("; ");
  if (refused.length > 0 && findings.length === 0)
    return {
      state: "failed",
      text,
      message: cutText(
        `The review did not finish: the reviewer was refused what it asked for and found nothing, so the change is not known to be fine. Refused: ${refusals}`,
        500,
      ),
    };
  // What the reviewer asked for and did not get, so the user knows the review may have stopped short.
  const refusedMessage =
    refused.length === 0 ? null : cutText(`The reviewer asked for more than reading the task and was refused: ${refusals}`, 500);
  return { state: "done", findings, text, message: joinedMessage([refusedMessage, omittedMessage(omittedRules)]) };
}

function stoppedWithDaemon(review: AutoReview, finishedAt: string | null): AutoReview {
  return { ...review, state: "cancelled", finishedAt, message: STOPPED_WITH_DAEMON };
}

/** The answer as the review keeps it: without invisible characters, cut at `AUTO_REVIEW_TEXT_MAX`. */
function kept(answer: string): string {
  return cutText(withoutInvisibleCharacters(answer).trim(), AUTO_REVIEW_TEXT_MAX);
}

/** The worktree's path as the daemon knows it and with its links resolved, as the reviewer's working directory has it. */
function worktreePaths(worktree: string): string[] {
  try {
    return [worktree, realpathSync.native(worktree)];
  } catch {
    return [worktree];
  }
}
