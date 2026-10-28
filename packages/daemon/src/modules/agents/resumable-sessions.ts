import { RepoId, SessionView, TaskId } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { ConversationId } from "./acp-messages.ts";
import { readStateFile } from "./state-file.ts";

/**
 * The sessions that run, kept in a file of the state directory so that the next daemon resumes them (ADR-95, §4.4):
 * sessions live in daemon memory and end with it, but Copilot CLI keeps each conversation under its session id, so a
 * new session with `--resume=<id>` goes on with it. The file follows the running sessions while the daemon works, and
 * stops following them once the daemon stops, so the sessions its stop ends stay in it; after a crash it holds those
 * of the last check.
 */

/** One session to resume: the supervisor or a free session (`repo: null`), a main session in a repo root, or a task's session. */
export const ResumableSession = z.preprocess(
  // A file of a Trackwall before free sessions (ADR-100) has no `supervisor`: a session without a repo there was the supervisor.
  (row) => (isRecord(row) && !("supervisor" in row) ? { ...row, supervisor: row.repo === null && row.task === null } : row),
  z
    .object({
      /** The Trackwall session id, which every session but a task's also passes to Copilot CLI as its session id. */
      session: z.uuid(),
      repo: RepoId.nullable(),
      /** The supervisor, in the projects folder; without a repo and not the supervisor, a free session (ADR-100). */
      supervisor: z.boolean(),
      task: TaskId.nullable(),
      /** Copilot CLI keeps a conversation under the id (the session had a prompt): it resumes it, otherwise starts anew. */
      hasConversation: z.boolean(),
      /** The terminal or the conversation view (ADR-107); a file of a Trackwall before it has only terminals. */
      view: SessionView.default("terminal"),
      /**
       * Copilot CLI's id of the conversation when it is not the session id: one started in the conversation view, where
       * Copilot CLI picks the id itself (ADR-107).
       */
      conversation: ConversationId.optional(),
    })
    .refine((s) => !s.supervisor || (s.repo === null && s.task === null), "the supervisor has no repo and no task"),
);
export type ResumableSession = z.infer<typeof ResumableSession>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** What a resumed session is, for the log: its task, its repo, the supervisor or a free session. */
export function resumablePlace({ repo, supervisor, task }: ResumableSession): string {
  if (task !== null) return `task ${task}`;
  return repo ?? (supervisor ? "supervisor" : "free session");
}

/** A start of Copilot CLI in a terminal under a session's id: its arguments, and whether they carry its first message or resume its conversation. */
interface ResumeLaunch {
  id: string;
  args: readonly string[];
  promptOnStart: boolean;
  hasConversation: boolean;
  /** Copilot CLI's id of the conversation: the session id, unless it was started in the conversation view (ADR-107). */
  conversation: string;
}

/** A start of Copilot CLI in the conversation view (ADR-107): the conversation it loads, or a new one with a first message. */
export interface ConversationLaunch {
  id: string;
  load: string | undefined;
  firstMessage: string | undefined;
}

/** A start under a session's id, in the view it shows in. */
export type SessionLaunch = ({ view: "terminal" } & ResumeLaunch) | ({ view: "conversation" } & ConversationLaunch);

/** What a start that goes on with a session needs to know of it. */
type Resumed = Pick<ResumableSession, "session" | "hasConversation" | "conversation">;

/**
 * A start that goes on with the conversation Copilot CLI keeps under the session's id (ADR-95, ADR-96), or under its own
 * id for one started in the conversation view (ADR-107). It refuses to resume a session that never had a prompt: that
 * one starts anew under the same id.
 */
function resumeLaunch({ session: id, hasConversation, conversation = id }: Resumed): ResumeLaunch {
  const args = [hasConversation ? `--resume=${conversation}` : `--session-id=${id}`];
  return { id, args, promptOnStart: false, hasConversation, conversation: hasConversation ? conversation : id };
}

/** The same in `view`: a terminal resumes with `--resume`, the conversation view loads the conversation (ADR-107). */
export function sessionLaunch(view: SessionView, resumed: Resumed): SessionLaunch {
  if (view === "terminal") return { view, ...resumeLaunch(resumed) };
  const { session: id, hasConversation, conversation = id } = resumed;
  return { view, id, load: hasConversation ? conversation : undefined, firstMessage: undefined };
}

const ResumableSessionsFile = z.object({ sessions: z.array(ResumableSession) });

export class ResumableSessions {
  readonly #path: string;
  readonly #log: (msg: string) => void;
  /** The last content written, so an unchanged list is not written again at every check. */
  #written: string | undefined;
  #following = true;

  constructor(path: string, log: (msg: string) => void) {
    this.#path = path;
    this.#log = log;
  }

  /** The sessions the previous daemon left; a missing file means none, a broken one is moved aside and gives none. */
  read(): ResumableSession[] {
    const file = readStateFile(this.#path, ResumableSessionsFile, (problem, aside) =>
      this.#log(`${this.#path}: ${problem}; file moved to ${aside}, no session is resumed`),
    );
    return file?.sessions ?? [];
  }

  /** The sessions that run now; nothing once the daemon stops (`stopFollowing`). */
  follow(sessions: readonly ResumableSession[]): void {
    if (!this.#following) return;
    const text = `${JSON.stringify({ sessions }, null, 2)}\n`;
    if (text === this.#written) return;
    writeFileAtomic(this.#path, text);
    this.#written = text;
  }

  /** The daemon stops: the sessions it ends now stay in the file for the next daemon. */
  stopFollowing(): void {
    this.#following = false;
  }
}
