/**
 * The E2E tests of the UI (ADR-71): every `e2e/*.e2e.ts` with `bun test`, each a daemon with the fake Copilot CLI
 * serving the built UI to Chromium from Playwright (they are not in `pnpm test`, which would need the browser and the
 * UI build on every machine). `pnpm test:e2e` in the repo root builds the UI first; arguments go on to `bun test`.
 *
 *   pnpm test:e2e
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_DIR } from "../e2e/support/ui-dir.ts";
import { runTestFiles } from "./test-files.ts";

if (!existsSync(join(UI_DIR, "index.html"))) throw new Error("no built UI: run `pnpm test:e2e` from the repo root, which builds it first");
process.exit(runTestFiles(fileURLToPath(new URL("../e2e", import.meta.url)), ".e2e.ts", process.argv.slice(2)));
