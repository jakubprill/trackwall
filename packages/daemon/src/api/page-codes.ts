import { createHash, randomBytes } from "node:crypto";

/**
 * One-time page codes (ADR-161 addendum, §5.2): an address the daemon prints or opens in a browser carries a code in
 * `#code=` instead of the daemon token, because a browser keeps every address it opened in its history, which it may
 * sync elsewhere, while a daemon in a container keeps its token for days. The page trades the code for the token once,
 * with the code as its bearer on `POST /api/page-code/exchange`; after that, or after `PAGE_CODE_LIFETIME_MS`, the code
 * in the history opens nothing. Codes are kept only as hashes, in this process, and die with it.
 */

/** Long enough to print an address and paste it into a browser, short enough that a copy in the history is dead. */
export const PAGE_CODE_LIFETIME_MS = 60_000;
/** More open codes than anyone pastes in a minute: the oldest goes first, so asking for codes cannot fill memory. */
const MAX_OPEN_CODES = 32;

export class PageCodes {
  /** The hash of each open code with the time it expires, oldest first. */
  private readonly open = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A new code, valid once for `PAGE_CODE_LIFETIME_MS`. */
  issue(): string {
    this.dropExpired();
    while (this.open.size >= MAX_OPEN_CODES) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) break;
      this.open.delete(oldest);
    }
    const code = randomBytes(32).toString("base64url");
    this.open.set(hashOf(code), this.now() + PAGE_CODE_LIFETIME_MS);
    return code;
  }

  /**
   * Whether `code` is open; it is closed by this call either way. The lookup goes by the code's hash, so how long it takes
   * says nothing about the codes that are open.
   */
  take(code: string): boolean {
    const hash = hashOf(code);
    const expires = this.open.get(hash);
    this.open.delete(hash);
    return expires !== undefined && this.now() < expires;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [hash, expires] of this.open) if (expires <= now) this.open.delete(hash);
  }
}

function hashOf(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
