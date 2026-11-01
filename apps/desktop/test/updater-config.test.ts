import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseFile, REPO, TAURI_DIR } from "../scripts/lib.ts";
import { MANIFEST_FILE } from "../scripts/update-manifest.ts";

/** The part of `tauri.conf.json` the updater reads (ADR-53). */
const TauriConf = z.object({
  plugins: z.object({
    updater: z.object({ pubkey: z.string(), endpoints: z.array(z.string()), requireSignedVersion: z.boolean() }),
  }),
  bundle: z.record(z.string(), z.unknown()),
});
const conf = parseFile(join(TAURI_DIR, "tauri.conf.json"), TauriConf, JSON.parse);
const updater = conf.plugins.updater;

test("the updater key is a minisign public key", () => {
  expect(Buffer.from(updater.pubkey, "base64").toString("utf8")).toMatch(
    /^untrusted comment: minisign public key: [0-9A-F]{16}\n[A-Za-z0-9+/]{56}\n$/,
  );
});

test("the updater reads the manifest that release.yml publishes, from the latest release only", () => {
  // `latest` skips pre-releases, so a pre-release reaches only a check pointed at it (TRACKWALL_UPDATE_ENDPOINT).
  expect(updater.endpoints).toEqual([`https://github.com/jakubprill/trackwall/releases/latest/download/${MANIFEST_FILE}`]);
});

test("the updater refuses a package signed for another version than the manifest announces", () => {
  expect(updater.requireSignedVersion).toBe(true);
});

test("tauri build does not sign: CI has no signing key, release.yml signs the update packages itself", () => {
  expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
});

/** The jobs of a workflow file; a job's `environment` is a name or an object with one (pages.yml). */
const Workflow = z.object({ jobs: z.record(z.string(), z.object({ environment: z.unknown().optional() }).passthrough()) });
const SIGNING_SECRET = /secrets\.TAURI_SIGNING_/;
const SIGNING_ENVIRONMENT = "release";

test("only jobs of the release environment read the update signing key, so a workflow pushed on a branch cannot", () => {
  const workflowsDir = join(REPO, ".github", "workflows");
  for (const file of readdirSync(workflowsDir)) {
    const workflow = parseFile(join(workflowsDir, file), Workflow, (text) => Bun.YAML.parse(text));
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (!SIGNING_SECRET.test(JSON.stringify(job))) continue;
      expect({ file, name, environment: job.environment }).toEqual({ file, name, environment: SIGNING_ENVIRONMENT });
    }
  }
  const release = parseFile(join(workflowsDir, "release.yml"), Workflow, (text) => Bun.YAML.parse(text));
  expect(
    Object.entries(release.jobs)
      .filter(([, job]) => job.environment === SIGNING_ENVIRONMENT)
      .map(([name]) => name),
  ).toEqual(["build", "linux"]);
});
