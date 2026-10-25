// A tree of test processes: every level writes its PID to `<dir>/<level>.pid`, starts the next level
// and ignores gentle signals, so only killing the whole group can stop it.
// Arguments: <dir> <level> <depth> [exit-leader <code>]: the leader ends by itself with the code once the whole tree is up.
// Works under Bun and under Node (descendants get the same runtime flags).
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, levelArg, depthArg, mode, codeArg] = process.argv.slice(2);
if (dir === undefined) throw new Error("missing directory");
const level = Number(levelArg);
const depth = Number(depthArg);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
if (level + 1 < depth) {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), dir, String(level + 1), String(depth)], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
}
writeFileSync(join(dir, `${level}.pid`), String(process.pid));
console.log(`level ${level} running`);

if (level === 0 && mode === "exit-leader") {
  const last = join(dir, `${depth - 1}.pid`);
  const timer = setInterval(() => {
    if (!existsSync(last)) return;
    clearInterval(timer);
    console.error("the leader ends by itself");
    process.exit(Number(codeArg));
  }, 20);
} else {
  setInterval(() => {}, 60_000);
}
