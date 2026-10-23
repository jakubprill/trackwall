import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Hosting } from "../../src/modules/vcs/hosting.ts";

const fakeCli = join(import.meta.dir, "..", "fixtures", "fake-hosting-cli.ts");

export interface FakeHostingConfig {
  repos?: unknown[];
  apiError?: string;
  apiRaw?: string;
  cloneErrors?: Record<string, string>;
  cloneDelayMs?: number;
}

const Call = z.object({ args: z.array(z.string()), env: z.record(z.string(), z.string().optional()) });

/** `Hosting` z atrapą `gh` i `glab` (`fixtures/fake-hosting-cli.ts`) i odczyt jej wywołań. */
export function fakeHosting(config: FakeHostingConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-hosting-"));
  const log = join(dir, "calls.jsonl");
  const configFile = join(dir, "config.json");
  writeFileSync(log, "");
  writeFileSync(configFile, JSON.stringify({ ...config, log }));
  const cli = { command: process.execPath, args: [fakeCli, configFile] };
  return {
    hosting: new Hosting({ github: cli, gitlab: cli }),
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Call.parse(JSON.parse(line))),
  };
}
