import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, REPO } from "../scripts/lib.ts";

test("wersje daemona, tauri.conf i Cargo.toml są równe", () => {
  expect(() => assertVersionsMatch()).not.toThrow();
});

test("bieżąca wersja ma niepustą notatkę o zmianach, której release.yml użyje jako opisu wydania", () => {
  const notes = join(REPO, "docs", "release-notes", `v${assertVersionsMatch()}.md`);
  expect(readFileSync(notes, "utf8").trim()).not.toBe("");
});
