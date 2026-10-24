import { createHash, randomBytes } from "node:crypto";

/**
 * Tokeny sesji (ADR-39): każda sesja Copilot CLI dostaje losowy token w pliku w katalogu sesji, a jej most stdio
 * wysyła go z każdym żądaniem MCP, więc serwer MCP wie, która sesja woła. Daemon trzyma tylko skróty SHA-256:
 * odczyt pamięci daemona nie daje tokenu, a szukanie po skrócie nie zdradza tokenu czasem porównania.
 */
export class SessionTokens {
  /** Skrót tokenu → sesja. */
  readonly #sessions = new Map<string, string>();

  /** Nowy token sesji `session`. */
  issue(session: string): string {
    const token = randomBytes(32).toString("base64url");
    this.#sessions.set(tokenHash(token), session);
    return token;
  }

  /** Sesja tokenu albo `undefined` dla nieznanego tokenu (sesja zamknięta albo token zmyślony). */
  session(token: string): string | undefined {
    return this.#sessions.get(tokenHash(token));
  }

  /** Token sesji `session` przestaje działać. */
  revoke(session: string): void {
    for (const [hash, owner] of this.#sessions) if (owner === session) this.#sessions.delete(hash);
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
