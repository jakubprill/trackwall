import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_FILE, DaemonFile, HealthResult } from "@pitwall/protocol";
import { loopbackRequest } from "./loopback.ts";

/** Odkrywanie daemona przez `daemon.json` (§5.1). */

const LOCK_FILE = "daemon.lock";
/** Po tym czasie blokada startu jest uznawana za porzuconą, nawet jeśli PID z pliku żyje (recykling PID-ów). */
const LOCK_STALE_MS = 30_000;
/** Plik blokady bez PID-u młodszy niż to jest właśnie zapisywany przez innego startującego. */
const LOCK_WRITE_GRACE_MS = 2_000;

export function daemonFilePath(home: string): string {
  return join(home, DAEMON_FILE);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readDaemonFile(home: string): DaemonFile | undefined {
  try {
    const parsed = DaemonFile.safeParse(JSON.parse(readFileSync(daemonFilePath(home), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Zapis atomowy (plik tymczasowy + rename), uprawnienia tylko dla właściciela tam, gdzie system je ma. */
export function writeDaemonFile(home: string, file: DaemonFile): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = daemonFilePath(home);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

/** Usuwa `daemon.json` tylko wtedy, gdy nadal opisuje ten proces (nie kasuje pliku następcy). */
export function removeDaemonFile(home: string, pid: number): void {
  const current = readDaemonFile(home);
  if (current?.pid === pid) rmSync(daemonFilePath(home), { force: true });
}

/** Wersja działającego daemona z `daemon.json` albo `undefined`, gdy nikt nie odpowiada. */
export async function probeRunningDaemon(home: string, timeoutMs = 1500): Promise<{ file: DaemonFile; version: string } | undefined> {
  const file = readDaemonFile(home);
  if (!file) return undefined;
  try {
    const res = await loopbackRequest(file.port, "/api/health", { timeoutMs });
    const body = HealthResult.safeParse(JSON.parse(res.body));
    if (!body.success || !body.data.ok) return undefined;
    return { file, version: body.data.data.version };
  } catch {
    return undefined;
  }
}

/**
 * Sekcja krytyczna startu: sprawdzenie, czy daemon już działa, i zapis `daemon.json` przez nowego.
 * Bez niej dwa równoczesne starty (dwuklik, Tauri + `--ui`) zostawiają dwa daemony, z których jeden jest niewidoczny.
 */
export async function withStartLock<T>(home: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, LOCK_FILE);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isStaleLock(lock)) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`blokada startu ${lock} trzymana dłużej niż ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true });
    } catch {
      // ktoś uznał blokadę za porzuconą i ją usunął
    }
  }
}

function isStaleLock(lock: string): boolean {
  let holder: number;
  let ageMs: number;
  try {
    holder = Number(readFileSync(lock, "utf8"));
    ageMs = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false; // zniknęła między próbami; następna iteracja ją utworzy
  }
  if (ageMs > LOCK_STALE_MS) return true;
  if (!Number.isInteger(holder) || holder <= 0) return ageMs > LOCK_WRITE_GRACE_MS;
  return !isAlive(holder);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
