import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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

/** Where a test file first calls one of `names` at its top level; infinity when it calls none. */
function firstCall(source: string, names: readonly string[]): number {
  const offsets = names.map((name) => source.search(new RegExp(`^${name}\\(`, "m"))).filter((offset) => offset >= 0);
  return offsets.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...offsets);
}

test("a contract or E2E file sets its time limit before its hooks, which otherwise keep bun's 5 s", () => {
  // bun gives a hook the limit of the moment it is registered: an `afterAll` above `setDefaultTimeout` that stops a
  // daemon with its sessions passed on Linux and timed out on macOS, as an unnamed failure after the last test.
  const late: string[] = [];
  for (const [folder, suffix] of [
    ["contract", ".contract.ts"],
    ["e2e", ".e2e.ts"],
  ] as const) {
    const dir = join(import.meta.dir, "..", folder);
    for (const name of readdirSync(dir).filter((file) => file.endsWith(suffix))) {
      const source = readFileSync(join(dir, name), "utf8");
      const limit = firstCall(source, ["setDefaultTimeout"]);
      const hook = firstCall(source, ["beforeAll", "beforeEach", "afterEach", "afterAll"]);
      if (hook < limit && limit !== Number.POSITIVE_INFINITY) late.push(`${folder}/${name}`);
    }
  }

  expect(late).toEqual([]);
});
