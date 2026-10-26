import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs `bun test` on every file in `dir` whose name ends with `suffix` and returns its exit code. The contract and E2E
 * tests are not named *.test.ts on purpose, so that `pnpm test` leaves them out, and `bun test` runs such a file only
 * when given its full path.
 */
export function runTestFiles(dir: string, suffix: string, args: readonly string[]): number {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name));
  if (files.length === 0) throw new Error(`no *${suffix} in ${dir}`);
  return spawnSync(process.execPath, ["test", ...files, ...args], { stdio: "inherit" }).status ?? 1;
}
