import { RepoId, TaskId } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { readStateFile } from "./state-file.ts";

/**
 * The sessions that run, kept in a file of the state directory so that the next daemon resumes them (ADR-95, §4.4):
 * sessions live in daemon memory and end with it, but Copilot CLI keeps each conversation under its session id, so a
 * new session with `--resume=<id>` goes on with it. The file follows the running sessions while the daemon works, and
 * stops following them once the daemon stops, so the sessions its stop ends stay in it; after a crash it holds those
 * of the last check.
 */

/** One session to resume: the supervisor or a free session (`repo: null`), a main session in a repo root, or a task's session. */
export const ResumableSession = z.object({
  /** The Trackwall session id, which every session but a task's also passes to Copilot CLI as its session id. */
  session: z.uuid(),
  repo: RepoId.nullable(),
  /**
   * The supervisor; read only with `repo: null`, where `false` is a free session (ADR-100). A file of a Trackwall before
   * free sessions has no such field, and a session without a repo there was the supervisor.
   */
  supervisor: z.boolean().default(true),
  task: TaskId.nullable(),
  /** Copilot CLI keeps a conversation under the id (the session had a prompt): it resumes it, otherwise starts anew. */
  hasConversation: z.boolean(),
});
export type ResumableSession = z.infer<typeof ResumableSession>;

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
