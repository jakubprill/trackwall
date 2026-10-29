import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A test on real git that relies on bun's 5 s limit passes on Linux and times out on a busy Windows runner, so the
// suite's default limit must not quietly go back to bun's.

test("pnpm test gives every test the long time limit, so a test on real git need not ask for it", () => {
  const manifest = z
    .object({ scripts: z.object({ test: z.string() }) })
    .parse(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")));

  expect(manifest.scripts.test).toContain(`--timeout ${SLOW_TEST_TIMEOUT_MS}`);
});
