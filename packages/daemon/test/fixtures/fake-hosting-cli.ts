/**
 * Fake `gh` and `glab` for repo hosting tests. The first argument is a JSON file with the test settings; then the
 * arguments as the daemon passes them: `api --hostname <host> <path>`, `auth status --hostname <host>` or
 * `repo clone <repo> <directory>`.
 * Every call appends to `log` the arguments and the environment variables the daemon is meant to set.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";

const Config = z.object({
  log: z.string(),
  /** Repos in the shape of the hosting API response, split into pages by `page` and `per_page` from the query. */
  repos: z.array(z.unknown()).default([]),
  /** A message on stderr and code 1 for `api` with the given `--hostname`. */
  apiErrors: z.record(z.string(), z.string()).default({}),
  /** A raw `api` response instead of pages from `repos`. */
  apiRaw: z.string().optional(),
  /** `api` responses by the path without its query, for anything other than the repo list (merge requests, checks). */
  apiResponses: z.record(z.string(), z.unknown()).default({}),
  /** Repos whose clone ends in an error with this message. */
  cloneErrors: z.record(z.string(), z.string()).default({}),
  cloneDelayMs: z.number().default(0),
  /** A message on stderr and code 1 for `auth status` with the given `--hostname`; any other host is signed in. */
  authErrors: z.record(z.string(), z.string()).default({}),
});

const [configFile, ...args] = process.argv.slice(2);
if (!configFile) throw new Error("missing fake settings file");
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
  const path = args.at(-1) ?? "";
  const response = config.apiResponses[path.split("?")[0] ?? ""];
  if (response !== undefined) {
    process.stdout.write(JSON.stringify(response));
    process.exit(0);
  }
  const query = new URL(path, "https://host/").searchParams;
  const page = Number(query.get("page"));
  const perPage = Number(query.get("per_page"));
  process.stdout.write(JSON.stringify(config.repos.slice((page - 1) * perPage, page * perPage)));
} else if (command === "auth" && subcommand === "status") {
  const authError = config.authErrors[args[3] ?? ""];
  if (authError) fail(authError);
  process.stdout.write(`Logged in to ${args[3]}\n`);
} else if (command === "repo" && subcommand === "clone") {
  const [, , repo, dest] = args;
  if (!repo || !dest) fail("missing repo or directory");
  await new Promise((resolve) => setTimeout(resolve, config.cloneDelayMs));
  const error = config.cloneErrors[repo];
  if (error) fail(error);
  mkdirSync(dest);
  execFileSync("git", ["init", "-q", "-b", "main", dest]);
} else {
  fail(`unknown command ${args.join(" ")}`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
