import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { parseFile, REPO } from "../scripts/lib.ts";

// Zakaz API Bun w daemonie poza platform/ (ADR-1) stoi w biome.json w kilku nadpisaniach, bo Biome nie łączy opcji
// reguły z kolejnych nadpisań, tylko bierze opcje ostatniego pasującego. Test sprawdza, co naprawdę obowiązuje w plikach.

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

/** Opcje reguły stylu z ostatniego nadpisania, które obejmuje plik i ustawia tę regułę. */
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

test("w daemonie poza platform/ obowiązuje zakaz importów bun i bun:*", () => {
  const withoutBan = DAEMON_OUTSIDE_PLATFORM.filter((path) => {
    const options = RestrictedImports.safeParse(effectiveOptions("noRestrictedImports", path));
    return !options.success || !options.data.patterns.some((p) => p.group.includes("bun") && p.group.includes("bun:*"));
  });
  expect(withoutBan).toEqual([]);
});

test("w daemonie poza platform/ obowiązuje zakaz globalnego Bun", () => {
  const withoutBan = DAEMON_OUTSIDE_PLATFORM.filter((path) => {
    const options = RestrictedGlobals.safeParse(effectiveOptions("noRestrictedGlobals", path));
    return !options.success || options.data.deniedGlobals.Bun === undefined;
  });
  expect(withoutBan).toEqual([]);
});

test("w platform/ import bun:ffi jest dozwolony", () => {
  const options = RestrictedImports.parse(effectiveOptions("noRestrictedImports", "packages/daemon/src/platform/win32-job.ts"));
  expect(options.patterns.some((p) => p.group.includes("bun:*"))).toBe(false);
});
