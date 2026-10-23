import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Check {
  name: string;
  ok: boolean;
  /** `false` = obserwacja do raportu, nie warunek sukcesu spike'a. */
  required: boolean;
  detail: string;
  ms?: number;
}

/** W skompilowanej binarce Bun skrypt leży w wirtualnym systemie plików i nie jest osobnym argumentem. */
export function isCompiled(): boolean {
  return import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
}

export function selfCommand(): string[] {
  return isCompiled() ? [process.execPath] : [process.execPath, fileURLToPath(new URL("./spike.ts", import.meta.url))];
}

export function spawnSelf(args: string[], opts: { detached?: boolean } = {}): ChildProcess {
  const [cmd, ...pre] = selfCommand();
  const child = spawn(cmd as string, [...pre, ...args], { stdio: "ignore", windowsHide: true, detached: opts.detached ?? false });
  child.on("error", () => {});
  return child;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const TREE_DEPTH = 3;

/** PID-y drzewa zapisane przez węzły `tree` w `dir/<poziom>.pid`. */
export function readTreePids(dir: string): number[] {
  const pids: number[] = [];
  for (let level = 0; level < TREE_DEPTH; level++) {
    const file = join(dir, `${level}.pid`);
    if (existsSync(file)) pids.push(Number(readFileSync(file, "utf8")));
  }
  return pids;
}

export async function waitUntil(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

export function check(name: string, ok: boolean, detail: string, required = true, ms?: number): Check {
  return { name, ok, required, detail, ms };
}
