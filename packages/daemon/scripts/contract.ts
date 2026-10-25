/**
 * The contract tests with the real Copilot CLI (ADR-67): downloads the pinned binary first, so the download does not
 * count against a test's time limit, then runs every `contract/*.contract.ts` with `bun test` (they are not in
 * `pnpm test`, which would need the binary on every machine). Arguments go on to `bun test`.
 *
 *   pnpm test:contract
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COPILOT_CLI_VERSION, copilotCli } from "./copilot-cli.ts";

const CONTRACT_DIR = fileURLToPath(new URL("../contract", import.meta.url));

const binary = await copilotCli();
process.stdout.write(`Copilot CLI ${COPILOT_CLI_VERSION}: ${binary}\n`);
// `bun test` takes a path as a file to run only when it starts with ./ or /; the files are not named *.test.ts on purpose.
const files = readdirSync(CONTRACT_DIR)
  .filter((name) => name.endsWith(".contract.ts"))
  .map((name) => join(CONTRACT_DIR, name));
if (files.length === 0) throw new Error(`no *.contract.ts in ${CONTRACT_DIR}`);
// One time limit for every test, above the sum of its waits (SESSION_MS each), so a slow step fails on its own message.
const run = spawnSync(process.execPath, ["test", "--timeout", "200000", ...files, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
