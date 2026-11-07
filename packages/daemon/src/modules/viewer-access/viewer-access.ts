import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VIEWER_FILE, type ViewerAccessState, type ViewerFile } from "@trackwall/protocol";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError, messageOf } from "../../infra/errors.ts";

/**
 * Viewer access (ADR-221, §8): the token of a read-only client on this computer, today the VS Code extension. It opens
 * only the viewer's session list (`api/server.ts`), never the rest of the API, MCP, the hooks or a WebSocket. It is off
 * until the user turns it on in Settings; `viewer.json` in the state directory is then both the record of the setting
 * and how the viewer finds the daemon, so turning it on is one switch and the file is there only while it is on. Each
 * daemon start issues a new token into the file, and turning access off removes the file and refuses the old token at
 * once. Like session tokens (ADR-39), the daemon keeps only the token's SHA-256 hash.
 */
export class ViewerAccess {
  readonly #file: string;
  readonly #log: (msg: string) => void;
  /** The API's port and start, known once it listens: a token can be issued only then. */
  #daemon: { port: number; instance: string } | undefined;
  #hash: Buffer | undefined;

  constructor(o: { home: string; log: (msg: string) => void }) {
    this.#file = join(o.home, VIEWER_FILE);
    this.#log = o.log;
  }

  /** After the API listens: when access was on in the last daemon start, a new token for this one. */
  open(daemon: { port: number; instance: string }): void {
    this.#daemon = daemon;
    if (!existsSync(this.#file)) return;
    try {
      this.#issue(daemon);
    } catch (err) {
      this.#log(`viewer access stays off: cannot write ${this.#file}: ${messageOf(err)}`);
    }
  }

  /** On while a token works or while the file is still there, so a file that could not be removed shows as on, not off. */
  state(): ViewerAccessState {
    return { enabled: this.#hash !== undefined || existsSync(this.#file), file: this.#file };
  }

  setEnabled(enabled: boolean): ViewerAccessState {
    if (!enabled) {
      // The token is refused first; a file that cannot be removed fails the request, and Settings still shows access on,
      // since the next daemon start would issue a token into it again.
      this.#hash = undefined;
      rmSync(this.#file, { force: true, maxRetries: 3, retryDelay: 100 });
      return this.state();
    }
    if (!this.#daemon) throw new DomainError("bad_request", "the daemon's API is not listening yet");
    this.#issue(this.#daemon);
    return this.state();
  }

  /** Whether `token` is the viewer token of this daemon start, compared in constant time; always `false` while access is off. */
  accepts(token: string): boolean {
    return this.#hash !== undefined && timingSafeEqual(tokenHash(token), this.#hash);
  }

  #issue(daemon: { port: number; instance: string }): void {
    const token = randomBytes(32).toString("base64url");
    const file: ViewerFile = { port: daemon.port, token, instance: daemon.instance };
    // Refused by the old token from here on, even when writing the file fails.
    this.#hash = undefined;
    writeFileAtomic(this.#file, `${JSON.stringify(file, null, 2)}\n`, 0o600);
    this.#hash = tokenHash(token);
  }
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
