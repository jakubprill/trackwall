// A fake `mise` for the tests of the `mise` and `batch` modules: its behaviour follows `fake-mise.json` in the working directory
// (the repo root). { tasks: [{ name, description?, hide? }], untrusted?: boolean, exits?: { [task]: code }, installExit?: code }
// `tasks ls --json` prints the mise tasks or the trust error, `trust` clears `untrusted`. `run <task>` prints the mise task's name
// and, when the mise task is in `exits`, ends at once with that code, and otherwise starts a process tree from `process-tree.ts`
// (PIDs in `<repo>/pids`) that runs until stopped. `install` ends with the code `installExit` (0 by default).
// `run` (with its arguments), `install` and `trust <file>` append to `calls.log` in the working directory, so that the test
// sees the order; `trustFileError` fails `trust <file>` with that mise error. Without `fake-mise.json` in the working
// directory there are no mise tasks. A mise task in `servers` runs
// `fake-service.ts` with that config instead (the `services` tests, ADR-45). A config in a directory listed in
// `MISE_TRUSTED_CONFIG_PATHS` counts as trusted (task worktrees, ADR-59). A mise task in `exits` first prints its lines in
// `prints` and writes its files in `writes` (path relative to the working directory -> content), e.g. a JUnit report (ADR-64).
// `env --json` prints `env` (the variables of the config's `[env]`, as decrypted values) and `env --redacted --json` only those
// named in `redacted`, as mise does for `redact = true` and age values (ADR-93); an untrusted config fails both like `tasks
// ls`, and `envError` fails them with that mise error (e.g. a missing age key), `redactedError` only the `--redacted` one.
// With `MISE_ENV` set (one name or several with commas), `env` also has the variables of `envByMiseEnv[name]` of each
// name in turn over `env`, as mise reads `mise.<name>.toml` (ADR-136).
// `fmt --check` fails like mise, naming the files in `unformatted` (relative to the working directory) by full path, and `fmt`
// clears them and appends `fmt` to `calls.log`. `tasks validate --json` prints `validation` (mise's issues) and fails when
// one is an error; `unknownFields` (`mise.toml:4:2: taskz (did you mean tasks?)`) go to stderr of `tasks ls` and `tasks
// validate` as mise's warnings, with the full path. `fmtUnsupported` makes both answer like a mise without these commands.
// `noConfig` makes `fmt --check` fail like mise in a repo without a config of its own, whose tasks come from the projects folder.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";

const configPath = join(process.cwd(), "fake-mise.json");
const config = (existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : { tasks: [] }) as {
  tasks: unknown[];
  untrusted?: boolean;
  exits?: Record<string, number>;
  installExit?: number;
  servers?: Record<string, object>;
  prints?: Record<string, string[]>;
  writes?: Record<string, Record<string, string>>;
  env?: Record<string, string>;
  redacted?: string[];
  envByMiseEnv?: Record<string, Record<string, string>>;
  envError?: string;
  redactedError?: string;
  trustFileError?: string;
  unformatted?: string[];
  validation?: { task: string; severity: string; category: string; message: string; details: string }[];
  unknownFields?: string[];
  fmtUnsupported?: boolean;
  noConfig?: boolean;
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

function warnUnknownFields(): void {
  for (const field of config.unknownFields ?? []) console.error(`mise WARN  unknown field in ${join(process.cwd(), field)}`);
}

function unsupported(command: string): void {
  if (!config.fmtUnsupported) return;
  console.error(`error: unrecognized subcommand '${command}'`);
  process.exit(2);
}

if (args[0] === "tasks" && args[1] === "ls" && args[2] === "--json") {
  refuseUntrusted();
  warnUnknownFields();
  console.log(JSON.stringify(config.tasks));
} else if (args[0] === "tasks" && args[1] === "validate" && args[2] === "--json") {
  unsupported("validate");
  refuseUntrusted();
  warnUnknownFields();
  const issues = config.validation ?? [];
  const errors = issues.filter((i) => i.severity === "error").length;
  console.log(JSON.stringify({ tasks_validated: config.tasks.length, errors, warnings: issues.length - errors, issues }, null, 2));
  if (errors > 0) {
    console.error(`mise ERROR Validation failed with ${errors} error(s)`);
    process.exit(1);
  }
} else if (args[0] === "fmt" && args[1] === "--check") {
  unsupported("fmt");
  if (config.noConfig) {
    console.error("mise ERROR No config file found in current directory");
    console.error("mise ERROR Version: 2026.11.1 linux-x64 (2026-11-04)");
    process.exit(1);
  }
  const files = config.unformatted ?? [];
  if (files.length > 0) {
    console.error("mise ERROR Following config files are not properly formatted:");
    for (const file of files) console.error(join(process.cwd(), file));
    console.error("mise ERROR Version: 2026.11.1 linux-x64 (2026-11-04)");
    process.exit(1);
  }
} else if (args[0] === "fmt" && args[1] === undefined) {
  appendFileSync(calls, "fmt\n");
  writeFileSync(configPath, JSON.stringify({ ...config, unformatted: [] }));
} else if (args[0] === "env" && args.at(-1) === "--json") {
  refuseUntrusted();
  const envError = args[1] === "--redacted" ? (config.redactedError ?? config.envError) : config.envError;
  if (envError !== undefined) {
    console.error(`mise ERROR ${envError}`);
    console.error("mise ERROR Version: 2026.10.21 linux-x64 (2026-10-27)");
    console.error("mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information");
    process.exit(1);
  }
  const names = (process.env.MISE_ENV ?? "").split(",").filter((name) => name !== "");
  const env = Object.assign({}, config.env, ...names.map((name) => config.envByMiseEnv?.[name]));
  const redacted = config.redacted ?? [];
  const shown = args[1] === "--redacted" ? Object.fromEntries(Object.entries(env).filter(([name]) => redacted.includes(name))) : env;
  console.log(JSON.stringify(shown, null, 2));
} else if (args[0] === "trust" && args[1] !== undefined) {
  appendFileSync(calls, `trust ${args[1]}\n`);
  if (config.trustFileError !== undefined) {
    console.error(`mise ERROR ${config.trustFileError}`);
    process.exit(1);
  }
  console.error(`mise trusted ${args[1]}`);
} else if (args[0] === "trust") {
  writeFileSync(configPath, JSON.stringify({ ...config, untrusted: false }));
  console.error(`mise trusted ${process.cwd()}`);
} else if (args[0] === "install") {
  appendFileSync(calls, "install\n");
  console.error("mise all tools are installed");
  process.exit(config.installExit ?? 0);
} else if (args[0] === "run" && args[1] !== undefined && config.exits?.[args[1]] !== undefined) {
  appendFileSync(calls, `${args.join(" ")}\n`);
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
  appendFileSync(calls, `${args.join(" ")}\n`);
  const pids = join(process.cwd(), "pids");
  mkdirSync(pids, { recursive: true });
  console.log(`[${args[1]}] $ process-tree`);
  const tree = spawn(process.execPath, [join(import.meta.dir, "process-tree.ts"), pids, "0", "2"], { stdio: "inherit", windowsHide: true });
  tree.on("exit", (code) => process.exit(code ?? 1));
} else {
  console.error(`fake mise: unknown command ${args.join(" ")}`);
  process.exit(2);
}
