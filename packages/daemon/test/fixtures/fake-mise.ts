// Atrapa `mise` dla testów modułu `mise`: zachowanie wynika z `fake-mise.json` w katalogu roboczym (korzeń repo).
// { tasks: [{ name, description?, hide? }], untrusted?: boolean }
// `tasks ls --json` drukuje taski albo błąd zaufania, `trust` zdejmuje `untrusted`, `run <task>` uruchamia
// drzewo procesów z `process-tree.ts` (PID-y w `<repo>/pids`) i drukuje nazwę taska.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configPath = join(process.cwd(), "fake-mise.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as { tasks: unknown[]; untrusted?: boolean };
const args = process.argv.slice(2);

if (args[0] === "tasks" && args[1] === "ls" && args[2] === "--json") {
  if (config.untrusted) {
    console.error("mise WARN  HTTP GET https://mise.jdx.dev/releases.tsv failed");
    console.error(`mise ERROR Config files in ${join(process.cwd(), "mise.toml")} are not trusted.`);
    process.exit(1);
  }
  console.log(JSON.stringify(config.tasks));
} else if (args[0] === "trust") {
  writeFileSync(configPath, JSON.stringify({ ...config, untrusted: false }));
  console.error(`mise trusted ${process.cwd()}`);
} else if (args[0] === "run" && args[1] !== undefined) {
  const pids = join(process.cwd(), "pids");
  mkdirSync(pids, { recursive: true });
  console.log(`[${args[1]}] $ process-tree`);
  const tree = spawn(process.execPath, [join(import.meta.dir, "process-tree.ts"), pids, "0", "2"], { stdio: "inherit", windowsHide: true });
  tree.on("exit", (code) => process.exit(code ?? 1));
} else {
  console.error(`atrapa mise: nieznana komenda ${args.join(" ")}`);
  process.exit(2);
}
