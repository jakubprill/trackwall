// Drzewo procesów testowych: każdy poziom zapisuje swój PID do `<dir>/<poziom>.pid`, odpala następny poziom
// i ignoruje łagodne sygnały, więc zatrzymać go może tylko zabicie całej grupy.
// Argumenty: <dir> <poziom> <głębokość> [exit-leader <kod>]: lider kończy się sam z kodem, gdy całe drzewo stoi.
// Działa pod Bun i pod Node (potomkowie dostają te same flagi runtime'u).
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, levelArg, depthArg, mode, codeArg] = process.argv.slice(2);
if (dir === undefined) throw new Error("brak katalogu");
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
console.log(`poziom ${level} działa`);

if (level === 0 && mode === "exit-leader") {
  const last = join(dir, `${depth - 1}.pid`);
  const timer = setInterval(() => {
    if (!existsSync(last)) return;
    clearInterval(timer);
    console.error("lider kończy się sam");
    process.exit(Number(codeArg));
  }, 20);
} else {
  setInterval(() => {}, 60_000);
}
