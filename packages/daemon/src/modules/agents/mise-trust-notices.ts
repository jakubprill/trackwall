import { MiseTarget, SessionId, TaskId } from "@trackwall/protocol";
import { z } from "zod";
import type { Restored } from "./task-coordination.ts";

/**
 * Which sessions a mise config without the user's trust refused, and which of them wait to hear that the user trusted
 * it (ADR-92): the user's click on "Trust" in the repo details or "Trust this config" in the task panel reaches the
 * agent that asked for it, so it runs again without the user telling it. Since ADR-115 they outlive a daemon restart in
 * `agent-queues.json` (`stored`, `restore`), every change reported to `changed`. A task's session waits through its
 * task, because a resumed task comes back in a new session, so the resumed one is told; any other session by its id,
 * under which the next daemon resumes it.
 *
 * A recipient is either refused in a target, or has a trust notice waiting. The notice is in every prompt the daemon
 * sends the session from then on, and counts as delivered once one is sent (typed or as a block, `promptSent`): the
 * end of the turn after that is the end of the turn the prompt started, and drops it.
 */

/** Whom a notice is for: a task's session through its task, any other session by its id. */
export const TrustRecipient = z.union([z.object({ task: TaskId }).strict(), z.object({ session: SessionId }).strict()]);
export type TrustRecipient = z.infer<typeof TrustRecipient>;

/** The recipient of a listed session. */
export function trustRecipientOf(session: { id: string; task: string | null }): TrustRecipient {
  return session.task === null ? { session: session.id } : { task: session.task };
}

/** A recipient's refusal, or the notice that waits for it since the user trusted the config. */
const Waiting = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refused"), target: MiseTarget }),
  z.object({ kind: z.literal("notice") }),
]);
type Waiting = z.infer<typeof Waiting>;

/**
 * What `agent-queues.json` keeps of the notices: each recipient's refusal or waiting notice. Whether a notice was sent
 * is not kept: the prompt that named it went to a session the stop ended, so the resumed one is told again.
 */
export const StoredTrustNotices = z.array(z.object({ recipient: TrustRecipient, waiting: Waiting }));
export type StoredTrustNotices = z.infer<typeof StoredTrustNotices>;

export class MiseTrustNotices {
  /** By `keyOf` of the recipient. */
  readonly #waiting = new Map<string, { recipient: TrustRecipient; waiting: Waiting }>();
  /** The keys whose notice went out in a prompt: the end of the turn after it drops the notice. */
  readonly #sent = new Set<string>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  stored(): StoredTrustNotices {
    return [...this.#waiting.values()];
  }

  /** The refusals and notices the previous daemon kept, of the tasks still there and the sessions it resumes under their id. */
  restore(stored: StoredTrustNotices, { hasTask, hasSession }: Restored): void {
    this.#waiting.clear();
    this.#sent.clear();
    for (const entry of stored)
      if ("task" in entry.recipient ? hasTask(entry.recipient.task) : hasSession(entry.recipient.session))
        this.#waiting.set(keyOf(entry.recipient), entry);
  }

  /** `recipient` runs something that needs a trusted mise config, or ended: what it waited for is over. */
  forget(recipient: TrustRecipient): void {
    const key = keyOf(recipient);
    this.#sent.delete(key);
    if (this.#waiting.delete(key)) this.#changed();
  }

  /** `recipient` was refused a run in `target` because of its mise config. */
  refused(recipient: TrustRecipient, target: MiseTarget): void {
    const key = keyOf(recipient);
    this.#sent.delete(key);
    this.#waiting.set(key, { recipient, waiting: { kind: "refused", target } });
    this.#changed();
  }

  /**
   * The user trusted the mise config of `trusted`: the repo root's (`task: null`), which every run in the repo needs,
   * worktrees included, or a task worktree's. Returns the recipients a run there was refused to, which have a notice now.
   */
  trusted(trusted: MiseTarget): TrustRecipient[] {
    const told = [...this.#waiting.values()].filter(
      ({ waiting }) =>
        waiting.kind === "refused" &&
        waiting.target.repo === trusted.repo &&
        (trusted.task === null || waiting.target.task === trusted.task),
    );
    for (const entry of told) entry.waiting = { kind: "notice" };
    if (told.length > 0) this.#changed();
    return told.map((entry) => entry.recipient);
  }

  /**
   * No session of `recipient` runs to hear the notice now. A task's notice waits for the session the user resumes, which
   * is asked to read when it starts, like its reviews; a session's is dropped, since nobody comes under its id.
   */
  notReached(recipient: TrustRecipient): void {
    if (!("task" in recipient)) this.forget(recipient);
  }

  /** Whether a notice waits for `recipient`. */
  waiting(recipient: TrustRecipient): boolean {
    return this.#waiting.get(keyOf(recipient))?.waiting.kind === "notice";
  }

  /** The daemon sent the session of `recipient` its prompt, which named the notice if one waited. */
  promptSent(recipient: TrustRecipient): void {
    if (this.waiting(recipient)) this.#sent.add(keyOf(recipient));
  }

  /** A turn of the session of `recipient` ended. */
  turnEnded(recipient: TrustRecipient): void {
    if (this.#sent.has(keyOf(recipient))) this.forget(recipient);
  }
}

/** One key per recipient, prefixed by its kind, so a task and a session with the same id stay apart. */
function keyOf(recipient: TrustRecipient): string {
  return "task" in recipient ? `task:${recipient.task}` : `session:${recipient.session}`;
}
