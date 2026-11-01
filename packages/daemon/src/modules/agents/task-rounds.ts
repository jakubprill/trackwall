import {
  CommitHash,
  PATCH_MAX_BYTES,
  TASK_ROUNDS_KEPT,
  TaskId,
  TaskRound,
  type TaskRounds,
  type WorkingTreeChanges,
} from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { KeyedQueue } from "../../infra/keyed-queue.ts";
import { readStateFile } from "../../infra/state-file.ts";

/**
 * Task rounds (§4.4, ADR-168): every turn of a task's agent that changed the worktree becomes a round with a commit of its
 * own. When a turn ends, what the agent left uncommitted is committed on the task branch (a round commit); "Undo round"
 * puts the worktree and branch back where the newest standing round started and tells the agent; and the round commits
 * the remote does not have yet are squashed before the user's push. An undo never drops work that is not the round's:
 * it is refused while the agent is in a turn, when the worktree changed since the round ended, when the round started
 * on changes from outside the rounds, and when the round is already pushed. Kept in `task-rounds.json`; the actions of
 * one task run one after another.
 */

export const TASK_ROUNDS_FILE = "task-rounds.json";

/** The subject of a round commit; the squash before the push replaces it. */
const roundCommitMessage = (round: number): string =>
  `WIP round ${round}\n\nTrackwall committed what this round of the task's agent left uncommitted, and squashes it before the push.`;

/** The longest subject of the commit that replaces round commits at the end of the branch. */
const SQUASHED_SUBJECT_MAX = 200;

/** Round commits on the branch that are not squashed yet, kept for the squash. */
const ROUND_COMMITS_KEPT = 5000;

const StoredRounds = z.object({
  task: TaskId,
  /** The number the next round gets. */
  next: z.number().int().positive(),
  /** Where the newest round left the worktree (or where the last undo or squash put it); `null` before the first turn. */
  head: CommitHash.nullable(),
  rounds: z.array(TaskRound).max(TASK_ROUNDS_KEPT),
  roundCommits: z.array(CommitHash).max(ROUND_COMMITS_KEPT),
  /** Rounds up to this number were squashed before a push and cannot be undone; 0 for none. */
  squashedThrough: z.number().int().nonnegative(),
  /** A round was undone and the agent has not been told yet. */
  undoneUntold: z.boolean(),
  problem: z.string().nullable(),
});
type StoredRounds = z.infer<typeof StoredRounds>;

const RoundsFile = z.object({ tasks: z.array(StoredRounds) });

// The types below repeat the shape of the types from `vcs` (`RoundPlace`, `RoundWorktree`, `SquashedRounds`), because a
// module does not import a neighbouring module (§4); the compiler checks they match where the facade passes `Vcs`.

/** A task worktree: its directory, the repo root it was made from, and the task branch. */
interface RoundPlace {
  worktree: string;
  repoDir: string;
  branch: string;
}

/** Where a task worktree is for a round. */
interface RoundWorktree {
  head: string | null;
  onBranch: boolean;
  uncommitted: number;
  blocker: string | null;
}

/** The squashed history, not on the branch yet. */
interface SquashedRounds {
  from: string;
  to: string;
}

/** What rounds need from `vcs` (`round-commits.ts`); wired in the facade. */
export interface RoundsVcs {
  roundWorktree(place: RoundPlace): Promise<RoundWorktree>;
  commitRound(place: RoundPlace, message: string, keepOut: readonly string[]): Promise<string>;
  roundChanges(dir: string, from: string, to: string, maxPatchBytes: number): Promise<WorkingTreeChanges>;
  resetRound(place: RoundPlace, head: string, to: string): Promise<void>;
  squashRounds(place: RoundPlace, base: string, roundCommits: ReadonlySet<string>, message: string): Promise<SquashedRounds | null>;
  moveBranch(place: RoundPlace, squashed: SquashedRounds): Promise<void>;
  pushedTip(dir: string, branch: string): Promise<string | null>;
  isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean>;
}

/** The task a round belongs to, as the task list has it, with the files copied into its worktree (ADR-61). */
export interface RoundTask extends RoundPlace {
  id: string;
  base: string;
  title: string | null;
  prompt: string;
  included: { files: readonly string[] };
}

export interface TaskRoundListDeps {
  vcs: RoundsVcs;
  path: string;
  /** The task, or `undefined` once it ended. */
  task: (id: string) => RoundTask | undefined;
  /** The task's running session is in the middle of a turn (`inTurn`). */
  midTurn: (task: string) => boolean;
  /** Asks the task's running session, if any, to read what waits for it. */
  askToRead: (task: string) => void;
  log: (msg: string) => void;
}

/** What a turn found when it started: the commit it started from and whether the worktree had changes from outside. */
interface TurnStart {
  from: string | null;
  outside: boolean;
}

export class TaskRoundList {
  readonly #deps: TaskRoundListDeps;
  readonly #state = new Map<string, StoredRounds>();
  readonly #turns = new Map<string, TurnStart>();
  readonly #chain = new KeyedQueue();

  constructor(deps: TaskRoundListDeps) {
    this.#deps = deps;
    const file = readStateFile(deps.path, RoundsFile, (problem, aside) => deps.log(`${deps.path}: ${problem}; file moved to ${aside}`));
    for (const stored of file?.tasks ?? []) if (deps.task(stored.task) !== undefined) this.#state.set(stored.task, stored);
  }

  /** A turn of the task's agent started: where the worktree is now, against where the last round left it. */
  turnStarted(task: string): Promise<void> {
    return this.#run(task, "reading the worktree at the start of a turn", async (work) => {
      const state = this.#stateOf(task);
      const now = await this.#deps.vcs.roundWorktree(work);
      const moved = state.head !== null && now.head !== state.head;
      this.#turns.set(task, { from: state.head ?? now.head, outside: moved || now.uncommitted > 0 });
    });
  }

  /** A turn of the task's agent ended: what it left uncommitted becomes the round commit, and a turn that changed something a round. */
  turnOver(task: string): Promise<void> {
    return this.#run(task, "committing the round", async (work) => {
      const state = this.#stateOf(task);
      // A turn whose start was not seen (a daemon restart in the middle of it) cannot vouch for what came before it.
      const turn = this.#turns.get(task) ?? { from: state.head, outside: true };
      this.#turns.delete(task);
      const ended = await this.#commitLeftovers(work, state.next);
      if ("problem" in ended) {
        this.#save(task, { ...state, problem: ended.problem });
        return;
      }
      const { head, roundCommit } = ended;
      const from = turn.from ?? work.base;
      if (from === head) {
        this.#save(task, { ...state, head, problem: null });
        return;
      }
      const round: TaskRound = {
        number: state.next,
        from,
        to: head,
        endedAt: new Date().toISOString(),
        roundCommit,
        outside: turn.outside || turn.from === null,
        undoneAt: null,
      };
      this.#save(task, {
        ...state,
        next: state.next + 1,
        head,
        rounds: [round, ...state.rounds].slice(0, TASK_ROUNDS_KEPT),
        roundCommits: roundCommit === null ? state.roundCommits : [...state.roundCommits, roundCommit].slice(-ROUND_COMMITS_KEPT),
        problem: null,
      });
    });
  }

  /** HEAD after the round commit of what the turn left uncommitted (`null` when it left nothing), or why there is none. */
  async #commitLeftovers(work: RoundTask, round: number): Promise<{ head: string; roundCommit: string | null } | { problem: string }> {
    const now = await this.#deps.vcs.roundWorktree(work);
    const problem = roundProblem(now);
    if (problem !== null) return { problem };
    if (now.head === null) return { problem: "the task branch has no commit" };
    if (now.uncommitted === 0) return { head: now.head, roundCommit: null };
    try {
      const head = await this.#deps.vcs.commitRound(work, roundCommitMessage(round), work.included.files);
      return { head, roundCommit: head === now.head ? null : head };
    } catch (err) {
      return { problem: `the round could not be committed: ${firstLine(messageOf(err))}` };
    }
  }

  /** The task's round commits that the push has not squashed yet. */
  roundCommits(task: string): ReadonlySet<string> {
    return new Set(this.#stateOf(task).roundCommits);
  }

  /** The task's rounds and what "Undo round" would do now. */
  list(task: string): Promise<TaskRounds> {
    const work = this.#task(task);
    return this.#chain.run(task, () => this.#view(work, this.#stateOf(task)));
  }

  /** One round's files and diff. */
  async changes(task: string, number: number): Promise<WorkingTreeChanges> {
    const work = this.#task(task);
    const round = this.#stateOf(task).rounds.find((r) => r.number === number);
    if (round === undefined) throw new DomainError("not_found", `task ${task} keeps no round ${number}`);
    return this.#deps.vcs.roundChanges(work.worktree, round.from, round.to, PATCH_MAX_BYTES).catch((err: unknown) => {
      throw new DomainError("repo_unavailable", `round ${number}: ${messageOf(err)}`);
    });
  }

  /** Undoes round `number`, the newest that stands, when nothing else would be lost; the agent is asked to read about it. */
  undo(task: string, number: number): Promise<TaskRounds> {
    const work = this.#task(task);
    return this.#chain.run(task, async () => {
      const state = this.#stateOf(task);
      const { undo, blocked } = await this.#view(work, state);
      if (undo !== number) throw new DomainError("bad_request", `round ${number} is not the newest round that stands`);
      if (blocked !== null) throw new DomainError("bad_request", blocked);
      const round = state.rounds.find((r) => r.number === number);
      if (round === undefined) throw new Error(`round ${number} of task ${task} is not kept`);
      await this.#deps.vcs.resetRound(work, round.to, round.from).catch((err: unknown) => {
        throw new DomainError("repo_unavailable", `undoing round ${number}: ${messageOf(err)}`);
      });
      const undoneAt = new Date().toISOString();
      const undone = {
        ...state,
        head: round.from,
        rounds: state.rounds.map((r) => (r.number === number ? { ...r, undoneAt } : r)),
        roundCommits: state.roundCommits.filter((c) => c !== round.roundCommit),
        undoneUntold: true,
      };
      this.#save(task, undone);
      this.#deps.askToRead(task);
      return this.#view(work, undone);
    });
  }

  /**
   * Runs the user's push (§4.12) with the task's round commits the remote does not have yet squashed: `push` gets the
   * squashed commit (`undefined` when there is none to squash), and only once it succeeded does the branch move there, so a
   * failed push leaves the branch and its rounds as they were. Refused in the middle of a turn, when the agent may commit.
   */
  pushWithRoundsSquashed(task: string, push: (source: string | undefined) => Promise<void>): Promise<void> {
    const work = this.#task(task);
    return this.#chain.run(task, async () => {
      const state = this.#stateOf(task);
      if (state.roundCommits.length === 0) return push(undefined);
      if (this.#deps.midTurn(task))
        throw new DomainError(
          "bad_request",
          "the agent is in the middle of a turn: push once it waits for you, so its round is in the push",
        );
      const squashed = await this.#deps.vcs
        .squashRounds(work, work.base, new Set(state.roundCommits), squashedSubject(work))
        .catch((err: unknown) => {
          throw new DomainError("repo_unavailable", `the round commits cannot be squashed before the push: ${messageOf(err)}`);
        });
      if (squashed === null) return push(undefined);
      // The branch moves before the push, so a turn that starts during it builds on the squashed history, and back
      // when the push fails, unless the agent committed meanwhile, which keeps the squashed history the push would take.
      await this.#deps.vcs.moveBranch(work, squashed).catch((err: unknown) => {
        throw new DomainError("repo_unavailable", `the task branch moved while its round commits were squashed: ${messageOf(err)}`);
      });
      try {
        await push(squashed.to);
      } catch (err) {
        await this.#deps.vcs.moveBranch(work, { from: squashed.to, to: squashed.from }).catch((back: unknown) => {
          this.#deps.log(`task ${task}: the branch stays squashed after the failed push: ${messageOf(back)}`);
        });
        throw err;
      }
      const moved = (commit: string | null) => (commit === squashed.from ? squashed.to : commit);
      const turn = this.#turns.get(task);
      if (turn !== undefined) this.#turns.set(task, { ...turn, from: moved(turn.from) });
      const now = this.#stateOf(task);
      this.#save(task, { ...now, head: moved(now.head), roundCommits: [], squashedThrough: state.next - 1 });
    });
  }

  /** Whether the agent has yet to hear that a round of its task was undone. */
  undoneUntold(task: string): boolean {
    return this.#state.get(task)?.undoneUntold === true;
  }

  /** The daemon's prompt, which says what waits, went to the task's agent. */
  promptSent(task: string): void {
    const state = this.#state.get(task);
    if (state?.undoneUntold) this.#save(task, { ...state, undoneUntold: false });
  }

  /** The task ended: its rounds go with it. */
  forget(task: string): void {
    this.#turns.delete(task);
    if (this.#state.delete(task)) this.#write();
  }

  /** Runs a turn's step after the task's earlier ones; a failure is logged, never thrown into the session's hook. */
  #run(task: string, what: string, step: (work: RoundTask) => Promise<void>): Promise<void> {
    return this.#chain.run(task, async () => {
      const work = this.#deps.task(task);
      if (work === undefined) return;
      await step(work).catch((err: unknown) => this.#deps.log(`task ${task}: ${what}: ${messageOf(err)}`));
    });
  }

  async #view(work: RoundTask, state: StoredRounds): Promise<TaskRounds> {
    const newest = state.rounds.find((r) => r.undoneAt === null) ?? null;
    const blocked = newest === null ? null : await this.#blocked(work, state, newest);
    return { rounds: state.rounds, undo: newest?.number ?? null, blocked, problem: state.problem };
  }

  /** Why round `round` cannot be undone now; `null` when it can. */
  async #blocked(work: RoundTask, state: StoredRounds, round: TaskRound): Promise<string | null> {
    const n = round.number;
    if (n <= state.squashedThrough) return `Round ${n} was squashed before a push, so it cannot be undone.`;
    if (this.#deps.midTurn(work.id)) return "The agent is in the middle of a turn: undo once it waits for you.";
    if (round.outside)
      return `Round ${n} started with changes made outside the agent's rounds (by hand, or before Trackwall saw the turn start): undoing it would drop them too.`;
    const { vcs } = this.#deps;
    const now = await vcs.roundWorktree(work);
    const problem = roundProblem(now);
    if (problem !== null) return `Round ${n} cannot be undone now: ${problem}.`;
    if (now.head !== round.to || now.uncommitted > 0)
      return `The worktree changed since round ${n} ended (by hand or by the agent), so Trackwall does not undo it: nothing would be left of those changes.`;
    if (!(await vcs.isAncestor(work.worktree, round.from, round.to)))
      return `The branch's history was rewritten since round ${n} started, so it cannot be undone.`;
    const pushed = await vcs.pushedTip(work.worktree, work.branch);
    if (pushed !== null && !(await vcs.isAncestor(work.worktree, pushed, round.from)))
      return `Round ${n} is already pushed: undoing it would need a force push, which Trackwall never does.`;
    return null;
  }

  #task(id: string): RoundTask {
    const work = this.#deps.task(id);
    if (work === undefined) throw new DomainError("not_found", `no task ${id}`);
    return work;
  }

  #stateOf(task: string): StoredRounds {
    return (
      this.#state.get(task) ?? {
        task,
        next: 1,
        head: null,
        rounds: [],
        roundCommits: [],
        squashedThrough: 0,
        undoneUntold: false,
        problem: null,
      }
    );
  }

  #save(task: string, state: StoredRounds): void {
    // A task that ended while its step ran leaves nothing behind.
    if (this.#deps.task(task) === undefined) return;
    this.#state.set(task, state);
    this.#write();
  }

  #write(): void {
    try {
      writeFileAtomic(this.#deps.path, `${JSON.stringify({ tasks: [...this.#state.values()] }, null, 2)}\n`);
    } catch (err) {
      this.#deps.log(`${this.#deps.path}: ${messageOf(err)}`);
    }
  }
}

/** Why the worktree cannot take a round commit or an undo now; `null` when it can. */
function roundProblem(now: RoundWorktree): string | null {
  if (now.blocker !== null) return now.blocker;
  if (!now.onBranch) return "HEAD is not on the task branch";
  return null;
}

/** The subject of the commit that replaces round commits at the end of the branch: the task's title, or its prompt's first line. */
function squashedSubject(task: RoundTask): string {
  const subject = firstLine(task.title ?? task.prompt).trim() || "Task changes";
  return subject.length > SQUASHED_SUBJECT_MAX ? `${subject.slice(0, SQUASHED_SUBJECT_MAX - 1)}…` : subject;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}
