import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Transport protection (§5.2, §8): only loopback in `Host`, `Origin` from the allowed list,
 * the token in `Authorization: Bearer` compared in constant time.
 */

/** Origins of the Tauri window: `tauri://localhost` (macOS) and `http(s)://tauri.localhost` (Windows). */
const TAURI_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export class OriginPolicy {
  /** Origins outside the daemon's page that get CORS: the Tauri window and an explicit `--allow-origin` (e.g. `tauri dev`). */
  private readonly cross: Set<string>;
  private readonly port: number;

  constructor(port: number, extraOrigins: readonly string[] = []) {
    this.port = port;
    this.cross = new Set([...TAURI_ORIGINS, ...extraOrigins]);
  }

  isAllowedHost(host: string | undefined): boolean {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  /**
   * No `Origin` means a client outside a browser (Tauri in Rust, the stdio bridge, curl) or a same-origin GET.
   * A page served by the daemon has an origin equal to its own address.
   */
  isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return this.isSelf(origin) || this.cross.has(origin);
  }

  /** The origin we send CORS headers back to; the daemon's own page is same-origin and does not need them. */
  corsOrigin(origin: string | undefined): string | undefined {
    return origin !== undefined && this.cross.has(origin) ? origin : undefined;
  }

  private isSelf(origin: string): boolean {
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }
}

/** The token in `Authorization: Bearer`, for the daemon token and the viewer token (ADR-221); `undefined` without one. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
}

/** Token comparison in constant time; shared by the `Authorization` header and the WebSocket subprotocol. */
export function tokenMatches(givenToken: string, token: string): boolean {
  const given = Buffer.from(givenToken);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
