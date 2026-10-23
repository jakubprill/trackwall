import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Ochrona transportu (§5.2, §8): tylko loopback w `Host`, `Origin` z listy dozwolonych,
 * token w `Authorization: Bearer` porównywany w stałym czasie.
 */

/** Originy okna Tauri: `tauri://localhost` (macOS) i `http(s)://tauri.localhost` (Windows). */
const TAURI_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export class OriginPolicy {
  /** Originy spoza strony daemona, które dostają CORS: okno Tauri i jawne `--allow-origin` (np. `tauri dev`). */
  private readonly cross: Set<string>;

  constructor(
    private readonly port: number,
    extraOrigins: readonly string[] = [],
  ) {
    this.cross = new Set([...TAURI_ORIGINS, ...extraOrigins]);
  }

  isAllowedHost(host: string | undefined): boolean {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  /**
   * Brak `Origin` oznacza klienta spoza przeglądarki (Tauri w Rust, `ws`, curl) albo same-origin GET.
   * Strona serwowana przez daemon ma origin równy jego własnemu adresowi.
   */
  isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return this.isSelf(origin) || this.cross.has(origin);
  }

  /** Origin, któremu odsyłamy nagłówki CORS; strona z daemona jest same-origin i ich nie potrzebuje. */
  corsOrigin(origin: string | undefined): string | undefined {
    return origin !== undefined && this.cross.has(origin) ? origin : undefined;
  }

  private isSelf(origin: string): boolean {
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }
}

export function hasValidToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
