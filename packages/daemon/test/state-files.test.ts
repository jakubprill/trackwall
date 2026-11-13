import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_FILES } from "../src/facade.ts";
import { readStateFile, stateVersion } from "../src/infra/state-file.ts";

// The state files an older Trackwall wrote (ADR-223): `fixtures/state-files/<version>/` keeps a file of each format as
// that format version wrote it, and every one of them must still read in the current Trackwall. A schema change that
// one of them fails needs a migration in the file's format, and a new format version keeps its own files next to them.

const FIXTURES = join(import.meta.dir, "fixtures", "state-files");

const SRC = join(import.meta.dir, "..", "src");

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
        const format = STATE_FILES[name];
        if (format === undefined) throw new Error(`${name} has no format in STATE_FILES`);
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
    for (const [name, format] of Object.entries(STATE_FILES)) {
      expect(readdirSync(join(FIXTURES, String(stateVersion(format))))).toContain(name);
    }
  });

  test("every state format the daemon defines is in STATE_FILES, which backups copy", async () => {
    const listed = Object.values(STATE_FILES);
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
