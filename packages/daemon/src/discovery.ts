import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_FILE, DaemonFile, HealthResult } from "@pitwall/protocol";

/** Odkrywanie daemona przez `daemon.json` (§5.1). */

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
    const res = await fetch(`http://127.0.0.1:${file.port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = HealthResult.safeParse(await res.json());
    if (!body.success || !body.data.ok) return undefined;
    return { file, version: body.data.data.version };
  } catch {
    return undefined;
  }
}
