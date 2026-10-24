import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO } from "../scripts/lib.ts";

// Pilnuje układu katalogów z docs/development.md („Układ repo”) i zakazu importów Bun poza platform/ (ADR-1).
// Sprawdza pliki całego repo, nie paczki desktop; leży tu, bo root nie ma własnych testów.
const rootEntries = (path: string) => readdirSync(join(REPO, path)).sort();

test("w korzeniu src/ daemona leżą tylko punkty wejścia i katalogi z docs/development.md", () => {
  expect(rootEntries("packages/daemon/src")).toEqual(["api", "facade.ts", "infra", "main.ts", "mcp", "modules", "platform"]);
});

test("w korzeniu src/ UI leżą tylko punkty wejścia, a widoki mają foldery nazwane identyfikatorem widoku", () => {
  expect(rootEntries("packages/ui/src")).toEqual(["App.tsx", "components", "index.css", "lib", "main.tsx", "views"]);
  expect(rootEntries("packages/ui/src/views")).toEqual(["daemon", "graph", "repos", "sessions", "settings"]);
});

const BUN_BAN = ["bun", "bun:*"];
const Pattern = z.object({ group: z.array(z.string()) });
const Override = z.object({
  includes: z.array(z.string()),
  linter: z
    .object({
      rules: z
        .object({
          style: z.object({ noRestrictedImports: z.object({ options: z.object({ patterns: z.array(Pattern) }) }).optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
const Biome = z.object({ overrides: z.array(Override) });

test("każde nadpisanie noRestrictedImports dla daemona poza platform/ powtarza zakaz importów Bun", () => {
  // Biome zastępuje opcje reguły w późniejszym nadpisaniu zamiast je łączyć, więc zakaz musi być w każdym z nich.
  const overrides = Biome.parse(JSON.parse(readFileSync(join(REPO, "biome.json"), "utf8"))).overrides;
  const daemonOutsidePlatform = overrides.filter(
    (o) =>
      o.includes.some((i) => i.startsWith("packages/daemon/src")) &&
      !o.includes.every((i) => i.startsWith("packages/daemon/src/platform")) &&
      o.linter?.rules?.style?.noRestrictedImports !== undefined,
  );
  expect(daemonOutsidePlatform.length).toBeGreaterThanOrEqual(3);
  for (const o of daemonOutsidePlatform) {
    const groups = o.linter?.rules?.style?.noRestrictedImports?.options.patterns.map((p) => p.group) ?? [];
    expect({ includes: o.includes, banned: groups.some((g) => BUN_BAN.every((b) => g.includes(b))) }).toEqual({
      includes: o.includes,
      banned: true,
    });
  }
});
