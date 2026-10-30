import { createHash, randomBytes } from "node:crypto";

/**
 * Session tokens (ADR-39): every Copilot CLI session gets a random token, which its MCP config (ADR-89) and its hooks
 * (ADR-88) send as a header with every request, so the MCP server knows which session is calling. The daemon keeps only
 * SHA-256 hashes: reading the daemon's memory does not give a token, and a lookup by hash does not leak the token
 * through comparison timing.
 */
export class SessionTokens {
  /** Token hash → session. */
  readonly #sessions = new Map<string, string>();

  /** A new token for session `session`. */
  issue(session: string): string {
    const token = randomBytes(32).toString("base64url");
    this.#sessions.set(tokenHash(token), session);
    return token;
  }

  /** The token's session or `undefined` for an unknown token (a closed session or a made-up token). */
  session(token: string): string | undefined {
    return this.#sessions.get(tokenHash(token));
  }

  /** Whether session `session` still has a token: a request recognised by it may outlive it while its body arrives. */
  holds(session: string): boolean {
    for (const owner of this.#sessions.values()) if (owner === session) return true;
    return false;
  }

  /** The token of session `session` stops working. */
  revoke(session: string): void {
    for (const [hash, owner] of this.#sessions) if (owner === session) this.#sessions.delete(hash);
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
