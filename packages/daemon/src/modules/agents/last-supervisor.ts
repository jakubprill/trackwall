import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { readStateFile } from "./state-file.ts";

/**
 * The newest supervisor, kept in a file of the state directory so that a start with `last` goes on with its
 * conversation (ADR-96): Copilot CLI keeps it under the supervisor's id, which outlives the session, the user closing
 * it and the daemon. The file follows the newest supervisor the daemon lists; once none is listed it keeps the last.
 */

export const LastSupervisor = z.object({
  /** The Trackwall session id, which the supervisor also passes to Copilot CLI as its session id (ADR-95). */
  session: z.uuid(),
  /** Copilot CLI keeps a conversation under the id (the supervisor had a prompt): only then is there one to go on with. */
  hasConversation: z.boolean(),
});
export type LastSupervisor = z.infer<typeof LastSupervisor>;

export class LastSupervisorFile {
  readonly #path: string;
  readonly #log: (msg: string) => void;
  /** What the file holds, once read or written; `null` for none. */
  #last: LastSupervisor | null | undefined;

  constructor(path: string, log: (msg: string) => void) {
    this.#path = path;
    this.#log = log;
  }

  /** The newest supervisor; a missing file means none, a broken one is moved aside and gives none. */
  read(): LastSupervisor | null {
    this.#last ??=
      readStateFile(this.#path, LastSupervisor, (problem, aside) =>
        this.#log(`${this.#path}: ${problem}; file moved to ${aside}, no supervisor conversation is resumed`),
      ) ?? null;
    return this.#last;
  }

  /** The newest supervisor the daemon lists now; written only when it changed. */
  follow(last: LastSupervisor): void {
    const known = this.read();
    if (known?.session === last.session && known.hasConversation === last.hasConversation) return;
    writeFileAtomic(this.#path, `${JSON.stringify(last, null, 2)}\n`);
    this.#last = last;
  }
}
