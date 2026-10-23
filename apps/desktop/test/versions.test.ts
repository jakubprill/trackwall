import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, REPO, versions } from "../scripts/lib.ts";

test("wersje daemona, tauri.conf i Cargo.toml są równe", () => {
  expect(new Set(Object.values(versions())).size).toBe(1);
});

test("bieżąca wersja ma notatkę o zmianach, której release.yml użyje jako opisu wydania", () => {
  const notes = join(REPO, "docs", "release-notes", `v${assertVersionsMatch()}.md`);
  expect(existsSync(notes)).toBe(true);
});
