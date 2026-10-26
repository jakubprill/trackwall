/**
 * The contract tests with the real Copilot CLI (ADR-67): downloads the pinned binary first, so the download does not
 * count against a test's time limit, then runs every `contract/*.contract.ts` with `bun test` (they are not in
 * `pnpm test`, which would need the binary on every machine). Arguments go on to `bun test`.
 *
 *   pnpm test:contract
 */
import { fileURLToPath } from "node:url";
import { copilotCli, copilotCliVersion } from "./copilot-cli.ts";
import { runTestFiles } from "./test-files.ts";

const binary = await copilotCli();
process.stdout.write(`Copilot CLI ${copilotCliVersion()}: ${binary}\n`);
process.exit(runTestFiles(fileURLToPath(new URL("../contract", import.meta.url)), ".contract.ts", process.argv.slice(2)));
