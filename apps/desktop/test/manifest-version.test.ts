import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cargoVersion, jsonVersion } from "../scripts/lib.ts";

const dir = mkdtempSync(join(tmpdir(), "trackwall-manifest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("jsonVersion returns the version field from a JSON file", () => {
  expect(jsonVersion(file("ok.json", '{ "name": "x", "version": "1.2.3" }'))).toBe("1.2.3");
});

test("jsonVersion throws an error naming the file when version is missing or not a string", () => {
  expect(() => jsonVersion(file("missing.json", '{ "name": "x" }'))).toThrow("missing.json");
  expect(() => jsonVersion(file("number.json", '{ "version": 1 }'))).toThrow("number.json");
});

test("cargoVersion reads version from [package], not from a dependency table", () => {
  const toml = '[dependencies.tauri]\nversion = "2"\n\n[package]\nname = "x"\nversion = "0.4.0"\n';
  expect(cargoVersion(file("Cargo.toml", toml))).toBe("0.4.0");
});

test("a syntax error in a file gives its path", () => {
  expect(() => jsonVersion(file("broken.json", '{ "version": "1.0.0", }'))).toThrow("broken.json");
  expect(() => cargoVersion(file("broken.toml", "[package\n"))).toThrow("broken.toml");
});

test("cargoVersion throws an error when [package] has no version", () => {
  expect(() => cargoVersion(file("no-version.toml", '[package]\nname = "x"\n'))).toThrow("no-version.toml");
});
