import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { parseFile, REPO } from "../scripts/lib.ts";

// The ban on Bun APIs in the daemon outside platform/ (ADR-1) stands in several overrides in biome.json, because Biome
// does not merge a rule's options from successive overrides but takes those of the last matching one. The test checks
// what really applies to the files.

const Rule = z.union([z.string(), z.object({ options: z.record(z.string(), z.unknown()).optional() })]);
const Override = z.object({
  includes: z.array(z.string()),
  linter: z.object({ rules: z.object({ style: z.record(z.string(), Rule).optional() }).optional() }).optional(),
});
const overrides = () => parseFile(join(REPO, "biome.json"), z.object({ overrides: z.array(Override) }), JSON.parse).overrides;

function covers(includes: string[], path: string): boolean {
  const positive = includes.filter((i) => !i.startsWith("!"));
  const negative = includes.filter((i) => i.startsWith("!")).map((i) => i.slice(1));
  return positive.some((g) => new Bun.Glob(g).match(path)) && !negative.some((g) => new Bun.Glob(g).match(path));
}

/** The options of a style rule from the last override that covers the file and sets that rule. */
function effectiveOptions(rule: string, path: string): unknown {
  const last = overrides()
    .filter((o) => covers(o.includes, path) && o.linter?.rules?.style?.[rule] !== undefined)
    .at(-1)?.linter?.rules?.style?.[rule];
  return typeof last === "object" ? last.options : undefined;
}

const RestrictedImports = z.object({ patterns: z.array(z.object({ group: z.array(z.string()) })) });
const RestrictedGlobals = z.object({ deniedGlobals: z.record(z.string(), z.string()) });

const DAEMON_OUTSIDE_PLATFORM = [
  "packages/daemon/src/main.ts",
  "packages/daemon/src/facade.ts",
  "packages/daemon/src/api/server.ts",
  "packages/daemon/src/mcp/endpoint.ts",
  "packages/daemon/src/infra/home.ts",
  "packages/daemon/src/modules/procs/procs.ts",
];

test("in the daemon outside platform/ imports of bun and bun:* are banned", () => {
  const withoutBan = DAEMON_OUTSIDE_PLATFORM.filter((path) => {
    const options = RestrictedImports.safeParse(effectiveOptions("noRestrictedImports", path));
    return !options.success || !options.data.patterns.some((p) => p.group.includes("bun") && p.group.includes("bun:*"));
  });
  expect(withoutBan).toEqual([]);
});

test("in the daemon outside platform/ the global Bun is banned", () => {
  const withoutBan = DAEMON_OUTSIDE_PLATFORM.filter((path) => {
    const options = RestrictedGlobals.safeParse(effectiveOptions("noRestrictedGlobals", path));
    return !options.success || options.data.deniedGlobals.Bun === undefined;
  });
  expect(withoutBan).toEqual([]);
});

test("in platform/ importing bun:ffi is allowed", () => {
  const options = RestrictedImports.parse(effectiveOptions("noRestrictedImports", "packages/daemon/src/platform/win32-job.ts"));
  expect(options.patterns.some((p) => p.group.includes("bun:*"))).toBe(false);
});
