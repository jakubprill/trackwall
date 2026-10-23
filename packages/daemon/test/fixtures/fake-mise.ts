// Atrapa `mise` dla testów modułów `mise` i `batch`: zachowanie wynika z `fake-mise.json` w katalogu roboczym
// (korzeń repo). { tasks: [{ name, description?, hide? }], untrusted?: boolean, exits?: { [task]: kod }, installExit?: kod }
// `tasks ls --json` drukuje taski albo błąd zaufania, `trust` zdejmuje `untrusted`. `run <task>` drukuje nazwę taska
// i, gdy task jest w `exits`, kończy się od razu z tym kodem, a inaczej uruchamia drzewo procesów z `process-tree.ts`
// (PID-y w `<repo>/pids`), które działa do zatrzymania. `install` kończy się kodem `installExit` (domyślnie 0).
// `run` i `install` dopisują się do `<repo>/calls.log`, żeby test widział kolejność.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configPath = join(process.cwd(), "fake-mise.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  tasks: unknown[];
  untrusted?: boolean;
  exits?: Record<string, number>;
  installExit?: number;
};
const args = process.argv.slice(2);
const calls = join(process.cwd(), "calls.log");

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
} else if (args[0] === "install") {
  appendFileSync(calls, "install\n");
  console.error("mise all tools are installed");
  process.exit(config.installExit ?? 0);
} else if (args[0] === "run" && args[1] !== undefined && config.exits?.[args[1]] !== undefined) {
  appendFileSync(calls, `run ${args[1]}\n`);
  console.log(`[${args[1]}] $ koniec`);
  process.exit(config.exits[args[1]]);
} else if (args[0] === "run" && args[1] !== undefined) {
  appendFileSync(calls, `run ${args[1]}\n`);
  const pids = join(process.cwd(), "pids");
  mkdirSync(pids, { recursive: true });
  console.log(`[${args[1]}] $ process-tree`);
  const tree = spawn(process.execPath, [join(import.meta.dir, "process-tree.ts"), pids, "0", "2"], { stdio: "inherit", windowsHide: true });
  tree.on("exit", (code) => process.exit(code ?? 1));
} else {
  console.error(`atrapa mise: nieznana komenda ${args.join(" ")}`);
  process.exit(2);
}
