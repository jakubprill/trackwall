import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Hosting, type HostingClis } from "../../src/modules/vcs/hosting.ts";

const fakeCli = join(import.meta.dir, "..", "fixtures", "fake-hosting-cli.ts");

export interface FakeHostingConfig {
  repos?: unknown[];
  apiErrors?: Record<string, string>;
  apiRaw?: string;
  apiResponses?: Record<string, unknown>;
  cloneErrors?: Record<string, string>;
  cloneDelayMs?: number;
  authErrors?: Record<string, string>;
}

const Call = z.object({ args: z.array(z.string()), env: z.record(z.string(), z.string().optional()) });

/** `Hosting` with fake `gh` and `glab` (`fixtures/fake-hosting-cli.ts`) and a read of its calls. */
export function fakeHosting(config: FakeHostingConfig = {}) {
  const { clis, calls } = fakeHostingClis(config);
  return { hosting: new Hosting(clis), calls };
}

/** Fake `gh` and `glab` for a whole facade, a read of their calls, and new settings for the calls after it. */
export function fakeHostingClis(config: FakeHostingConfig = {}): {
  clis: HostingClis;
  calls: () => z.infer<typeof Call>[];
  reconfigure: (config: FakeHostingConfig) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-hosting-"));
  const log = join(dir, "calls.jsonl");
  const configFile = join(dir, "config.json");
  writeFileSync(log, "");
  writeFileSync(configFile, JSON.stringify({ ...config, log }));
  const cli = { command: process.execPath, args: [fakeCli, configFile] };
  return {
    clis: { github: cli, gitlab: cli },
    reconfigure: (next) => writeFileSync(configFile, JSON.stringify({ ...next, log })),
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Call.parse(JSON.parse(line))),
  };
}
