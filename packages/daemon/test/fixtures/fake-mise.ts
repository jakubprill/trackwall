// A fake `mise` for the tests of the `mise` and `batch` modules: its behaviour follows `fake-mise.json` in the working directory
// (the repo root). { tasks: [{ name, description?, hide? }], untrusted?: boolean, exits?: { [task]: code }, installExit?: code }
// `tasks ls --json` prints the mise tasks or the trust error, `trust` clears `untrusted`. `run <task>` prints the mise task's name
// and, when the mise task is in `exits`, ends at once with that code, and otherwise starts a process tree from `process-tree.ts`
// (PIDs in `<repo>/pids`) that runs until stopped. `install` ends with the code `installExit` (0 by default).
// `run` and `install` append to `<repo>/calls.log`, so that the test sees the order. A mise task in `servers` runs
// `fake-service.ts` with that config instead (the `services` tests, ADR-45). A config in a directory listed in
// `MISE_TRUSTED_CONFIG_PATHS` counts as trusted (task worktrees, ADR-59). A mise task in `exits` first prints its lines in
// `prints` and writes its files in `writes` (path relative to the working directory -> content), e.g. a JUnit report (ADR-64).
// `env --json` prints `env` (the variables of the config's `[env]`, as decrypted values) and `env --redacted --json` only those
// named in `redacted`, as mise does for `redact = true` and age values (ADR-93); an untrusted config fails both like `tasks
// ls`, and `envError` fails them with that mise error (e.g. a missing age key), `redactedError` only the `--redacted` one.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";

const configPath = join(process.cwd(), "fake-mise.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  tasks: unknown[];
  untrusted?: boolean;
  exits?: Record<string, number>;
  installExit?: number;
  servers?: Record<string, object>;
  prints?: Record<string, string[]>;
  writes?: Record<string, Record<string, string>>;
  env?: Record<string, string>;
  redacted?: string[];
  envError?: string;
  redactedError?: string;
};
const args = process.argv.slice(2);
const calls = join(process.cwd(), "calls.log");

/**
 * Like mise, a config under a directory in `MISE_TRUSTED_CONFIG_PATHS` is trusted without `mise trust` (ADR-59),
 * compared by canonical path (the temporary directory on macOS is behind the `/var` link).
 */
const trustedByEnv = (process.env.MISE_TRUSTED_CONFIG_PATHS ?? "")
  .split(delimiter)
  .filter((dir) => dir !== "" && existsSync(dir))
  .map(canonical)
  .some((dir) => canonical(process.cwd()) === dir || canonical(process.cwd()).startsWith(`${dir}${sep}`));

function canonical(path: string): string {
  const real = realpathSync(path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function refuseUntrusted(): void {
  if (!config.untrusted || trustedByEnv) return;
  console.error("mise WARN  HTTP GET https://mise.jdx.dev/releases.tsv failed");
  console.error(`mise ERROR Config files in ${join(process.cwd(), "mise.toml")} are not trusted.`);
  process.exit(1);
}

if (args[0] === "tasks" && args[1] === "ls" && args[2] === "--json") {
  refuseUntrusted();
  console.log(JSON.stringify(config.tasks));
} else if (args[0] === "env" && args.at(-1) === "--json") {
  refuseUntrusted();
  const envError = args[1] === "--redacted" ? (config.redactedError ?? config.envError) : config.envError;
  if (envError !== undefined) {
    console.error(`mise ERROR ${envError}`);
    console.error("mise ERROR Version: 2026.10.21 linux-x64 (2026-10-27)");
    console.error("mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information");
    process.exit(1);
  }
  const env = config.env ?? {};
  const redacted = config.redacted ?? [];
  const shown = args[1] === "--redacted" ? Object.fromEntries(Object.entries(env).filter(([name]) => redacted.includes(name))) : env;
  console.log(JSON.stringify(shown, null, 2));
} else if (args[0] === "trust") {
  writeFileSync(configPath, JSON.stringify({ ...config, untrusted: false }));
  console.error(`mise trusted ${process.cwd()}`);
} else if (args[0] === "install") {
  appendFileSync(calls, "install\n");
  console.error("mise all tools are installed");
  process.exit(config.installExit ?? 0);
} else if (args[0] === "run" && args[1] !== undefined && config.exits?.[args[1]] !== undefined) {
  appendFileSync(calls, `run ${args[1]}\n`);
  for (const line of config.prints?.[args[1]] ?? []) console.log(line);
  for (const [file, content] of Object.entries(config.writes?.[args[1]] ?? {})) {
    mkdirSync(dirname(join(process.cwd(), file)), { recursive: true });
    writeFileSync(join(process.cwd(), file), content);
  }
  console.log(`[${args[1]}] $ done`);
  process.exit(config.exits[args[1]]);
} else if (args[0] === "run" && args[1] !== undefined && config.servers?.[args[1]] !== undefined) {
  appendFileSync(calls, `run ${args[1]}\n`);
  const service = spawn(process.execPath, [join(import.meta.dir, "fake-service.ts"), JSON.stringify(config.servers[args[1]])], {
    stdio: "inherit",
    windowsHide: true,
  });
  service.on("exit", (code) => process.exit(code ?? 1));
} else if (args[0] === "run" && args[1] !== undefined) {
  appendFileSync(calls, `run ${args[1]}\n`);
  const pids = join(process.cwd(), "pids");
  mkdirSync(pids, { recursive: true });
  console.log(`[${args[1]}] $ process-tree`);
  const tree = spawn(process.execPath, [join(import.meta.dir, "process-tree.ts"), pids, "0", "2"], { stdio: "inherit", windowsHide: true });
  tree.on("exit", (code) => process.exit(code ?? 1));
} else {
  console.error(`fake mise: unknown command ${args.join(" ")}`);
  process.exit(2);
}
