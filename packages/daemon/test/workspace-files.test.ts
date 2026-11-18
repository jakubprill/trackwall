import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceKey } from "@trackwall/protocol";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";

// The workspace.yaml an older Trackwall read (§4.5, ADR-278): `fixtures/workspace-files/<version>.yaml` sets every key as
// that version read it, and the current Trackwall must still read every one of them, with no key unknown and none broken.
// A change that one of them fails changes the meaning of a key users wrote by hand: it reads the old value too, or the key
// is deprecated first (§5.3's rule, the same for workspace.yaml). A release that adds a key adds a file of its own.

const FIXTURES = join(import.meta.dir, "fixtures", "workspace-files");

describe("workspace.yaml of older Trackwall versions", () => {
  for (const name of readdirSync(FIXTURES)) {
    test(`${name} still reads, every key from the file and none broken or unknown`, () => {
      const folder = mkdtempSync(join(tmpdir(), "trackwall-workspace-files-"));
      const text = readFileSync(join(FIXTURES, name), "utf8")
        .replaceAll("<projects>/", `${join(folder, "projects")}/`)
        .replaceAll("<projects>", join(folder, "projects"))
        .replaceAll("<tools>/", `${join(folder, "tools")}/`);
      const file = join(folder, "workspace.yaml");
      writeFileSync(file, text);

      const read = new WorkspaceFile(file).keyStates();

      expect(read.unknown).toEqual([]);
      expect(read.keys.filter((key) => key.problem !== null).map((key) => [key.key, key.problem])).toEqual([]);
      expect(read.keys.filter((key) => key.from === "file").map((key) => key.key)).toEqual(
        WorkspaceKey.options.filter((key) => text.includes(`\n${key}:`)),
      );
    });
  }

  test("the newest file sets every key the current Trackwall reads, so a key added since has its own file", () => {
    const newest = readdirSync(FIXTURES)
      .sort((a, b) => Bun.semver.order(a.replace(/\.yaml$/, ""), b.replace(/\.yaml$/, "")))
      .at(-1);
    if (newest === undefined) throw new Error("no workspace.yaml fixture");
    const text = readFileSync(join(FIXTURES, newest), "utf8");
    expect(WorkspaceKey.options.filter((key) => !text.includes(`\n${key}:`))).toEqual([]);
  });
});
