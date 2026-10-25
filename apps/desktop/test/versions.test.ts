import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, REPO } from "../scripts/lib.ts";

test("the versions of the daemon, tauri.conf and Cargo.toml are equal", () => {
  expect(() => assertVersionsMatch()).not.toThrow();
});

test("the current version has a non-empty release note, which release.yml uses as the release description", () => {
  const notes = join(REPO, "docs", "release-notes", `v${assertVersionsMatch()}.md`);
  expect(readFileSync(notes, "utf8").trim()).not.toBe("");
});
