/**
 * Atrapa `gh` i `glab` dla testów hostingów repo. Pierwszy argument to plik JSON z ustawieniami testu; dalej
 * argumenty tak, jak podaje je daemon: `api --hostname <host> <ścieżka>` albo `repo clone <repo> <katalog>`.
 * Każde wywołanie dopisuje do `log` argumenty i zmienne środowiskowe, które daemon ma ustawić.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";

const Config = z.object({
  log: z.string(),
  /** Repo w kształcie odpowiedzi API hostingu, dzielone na strony według `page` i `per_page` z zapytania. */
  repos: z.array(z.unknown()).default([]),
  /** Komunikat na stderr i kod 1 dla `api` z danym `--hostname`. */
  apiErrors: z.record(z.string(), z.string()).default({}),
  /** Surowa odpowiedź `api` zamiast stron z `repos`. */
  apiRaw: z.string().optional(),
  /** Repo, których klon kończy się błędem z tym komunikatem. */
  cloneErrors: z.record(z.string(), z.string()).default({}),
  cloneDelayMs: z.number().default(0),
});

const [configFile, ...args] = process.argv.slice(2);
if (!configFile) throw new Error("brak pliku z ustawieniami atrapy");
const config = Config.parse(JSON.parse(readFileSync(configFile, "utf8")));
const env = Object.fromEntries(
  ["GH_HOST", "GITLAB_HOST", "GH_PROMPT_DISABLED", "NO_PROMPT", "GIT_TERMINAL_PROMPT", "GIT_DIR"].map((name) => [name, process.env[name]]),
);
appendFileSync(config.log, `${JSON.stringify({ args, env })}\n`);

const [command, subcommand] = args;
if (command === "api") {
  const apiError = config.apiErrors[args[2] ?? ""];
  if (apiError) fail(apiError);
  if (config.apiRaw !== undefined) {
    process.stdout.write(config.apiRaw);
    process.exit(0);
  }
  const query = new URL(args.at(-1) ?? "", "https://host/").searchParams;
  const page = Number(query.get("page"));
  const perPage = Number(query.get("per_page"));
  process.stdout.write(JSON.stringify(config.repos.slice((page - 1) * perPage, page * perPage)));
} else if (command === "repo" && subcommand === "clone") {
  const [, , repo, dest] = args;
  if (!repo || !dest) fail("brak repo albo katalogu");
  await new Promise((resolve) => setTimeout(resolve, config.cloneDelayMs));
  const error = config.cloneErrors[repo];
  if (error) fail(error);
  mkdirSync(dest);
  execFileSync("git", ["init", "-q", "-b", "main", dest]);
} else {
  fail(`nieznana komenda ${args.join(" ")}`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
