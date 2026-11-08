import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeName, RoutineName } from "@trackwall/protocol";
import { KNOWLEDGE_APPROVALS_FILE, ROUTINE_APPROVALS_FILE } from "../src/facade.ts";
import { approvalsFormat } from "../src/infra/approved-folder.ts";
import { readStateFile, type StateFormat, stateVersion } from "../src/infra/state-file.ts";
import { AGENT_QUEUES_FORMAT } from "../src/modules/agents/agent-queues.ts";
import { AGENT_QUEUES_FILE, RESUMABLE_SESSIONS_FILE, TASKS_FILE } from "../src/modules/agents/agents.ts";
import { AUTO_REVIEWS_FILE, AUTO_REVIEWS_FORMAT } from "../src/modules/agents/auto-reviews.ts";
import { LAST_SUPERVISOR_FILE, LAST_SUPERVISOR_FORMAT } from "../src/modules/agents/last-supervisor.ts";
import { RESUMABLE_SESSIONS_FORMAT } from "../src/modules/agents/resumable-sessions.ts";
import { TASKS_FORMAT } from "../src/modules/agents/task-file.ts";
import { TASK_ROUNDS_FILE, TASK_ROUNDS_FORMAT } from "../src/modules/agents/task-rounds.ts";
import { REPRODUCTION_CHECKS_FILE, REPRODUCTION_CHECKS_FORMAT } from "../src/modules/reproduction/reproduction-checks.ts";
import { VERIFICATIONS_FILE, VERIFICATIONS_FORMAT } from "../src/modules/verification/verifications.ts";

// The state files an older Trackwall wrote (ADR-223): `fixtures/state-files/<version>/` keeps a file of each format as
// that format version wrote it, and every one of them must still read in the current Trackwall. A schema change that
// one of them fails needs a migration in the file's format, and a new format version keeps its own files next to them.

const FIXTURES = join(import.meta.dir, "fixtures", "state-files");

const SRC = join(import.meta.dir, "..", "src");

const FORMATS: Record<string, StateFormat<object>> = {
  [TASKS_FILE]: TASKS_FORMAT,
  [VERIFICATIONS_FILE]: VERIFICATIONS_FORMAT,
  [AUTO_REVIEWS_FILE]: AUTO_REVIEWS_FORMAT,
  [TASK_ROUNDS_FILE]: TASK_ROUNDS_FORMAT,
  [RESUMABLE_SESSIONS_FILE]: RESUMABLE_SESSIONS_FORMAT,
  [AGENT_QUEUES_FILE]: AGENT_QUEUES_FORMAT,
  [LAST_SUPERVISOR_FILE]: LAST_SUPERVISOR_FORMAT,
  [REPRODUCTION_CHECKS_FILE]: REPRODUCTION_CHECKS_FORMAT,
  [ROUTINE_APPROVALS_FILE]: approvalsFormat(RoutineName),
  [KNOWLEDGE_APPROVALS_FILE]: approvalsFormat(KnowledgeName),
};

/** The daemon's source files with their text, relative to `src`. */
function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

const versions = readdirSync(FIXTURES).sort((a, b) => Number(a) - Number(b));

describe("state files of older Trackwall versions (ADR-223)", () => {
  for (const version of versions) {
    for (const name of readdirSync(join(FIXTURES, version))) {
      test(`${name} of state format ${version} still reads`, () => {
        const format = FORMATS[name];
        if (format === undefined) throw new Error(`${name} has no format in this test`);
        // A copy, since a file that does not read is moved aside.
        const file = join(mkdtempSync(join(tmpdir(), "trackwall-state-files-")), name);
        copyFileSync(join(FIXTURES, version, name), file);
        const problems: string[] = [];
        const value = readStateFile(file, format, (problem) => problems.push(problem));
        expect(problems).toEqual([]);
        // Every top-level key the old file had is still there, so a migration that drops content fails too.
        const { version: _, ...kept } = JSON.parse(readFileSync(join(FIXTURES, version, name), "utf8"));
        expect(Object.keys(value ?? {})).toEqual(expect.arrayContaining(Object.keys(kept)));
      });
    }
  }

  test("every state format has a file of its current version", () => {
    for (const [name, format] of Object.entries(FORMATS)) {
      expect(readdirSync(join(FIXTURES, String(stateVersion(format))))).toContain(name);
    }
  });

  test("every state format the daemon defines is in this test", async () => {
    const listed = Object.values(FORMATS);
    for (const { file, text } of sources()) {
      for (const [, name] of text.matchAll(/export const (\w+) = stateFormat\(/g)) {
        const module: Record<string, unknown> = await import(join(SRC, file));
        expect({ file, name, listed: listed.some((format) => format === module[name ?? ""]) }).toEqual({ file, name, listed: true });
      }
    }
  });

  test("every state file the daemon reads or follows goes through a format of this test", () => {
    // The formats defined as exports, which the test above finds listed, and the approvals files' format, which each
    // folder builds from its names (`approvalsFormat`), listed above for both folders.
    const defined = sources().flatMap(({ text }) => [...text.matchAll(/export const (\w+) = stateFormat\(/g)].map((m) => m[1]));
    const known = [...defined, "this.#approvalsFormat"];
    for (const { file, text } of sources()) {
      if (file.endsWith("state-file.ts")) continue;
      for (const [, format] of text.matchAll(/(?:readStateFile|new FollowedStateFile)\(\s*[^,]+,\s*([\w.#]+)/g)) {
        expect({ file, format, known: known.includes(format ?? "") }).toEqual({ file, format, known: true });
      }
    }
  });
});
