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
import { copilotCli, copilotCliVersion } from "./copilot-cli.ts";

const CONTRACT_DIR = fileURLToPath(new URL("../contract", import.meta.url));

const binary = await copilotCli();
process.stdout.write(`Copilot CLI ${copilotCliVersion()}: ${binary}\n`);
// `bun test` takes a path as a file to run only when it starts with ./ or /; the files are not named *.test.ts on purpose.
const files = readdirSync(CONTRACT_DIR)
  .filter((name) => name.endsWith(".contract.ts"))
  .map((name) => join(CONTRACT_DIR, name));
if (files.length === 0) throw new Error(`no *.contract.ts in ${CONTRACT_DIR}`);
const run = spawnSync(process.execPath, ["test", ...files, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
