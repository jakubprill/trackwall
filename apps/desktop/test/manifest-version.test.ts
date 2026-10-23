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

test("jsonVersion zwraca pole version z pliku JSON", () => {
  expect(jsonVersion(file("ok.json", '{ "name": "x", "version": "1.2.3" }'))).toBe("1.2.3");
});

test("jsonVersion rzuca błąd z nazwą pliku, gdy version brakuje albo nie jest napisem", () => {
  expect(() => jsonVersion(file("brak.json", '{ "name": "x" }'))).toThrow("brak.json");
  expect(() => jsonVersion(file("liczba.json", '{ "version": 1 }'))).toThrow("liczba.json");
});

test("cargoVersion czyta version z [package], nie z tabeli zależności", () => {
  const toml = '[dependencies.tauri]\nversion = "2"\n\n[package]\nname = "x"\nversion = "0.4.0"\n';
  expect(cargoVersion(file("Cargo.toml", toml))).toBe("0.4.0");
});

test("błąd składni pliku podaje jego ścieżkę", () => {
  expect(() => jsonVersion(file("zepsuty.json", '{ "version": "1.0.0", }'))).toThrow("zepsuty.json");
  expect(() => cargoVersion(file("zepsuty.toml", "[package\n"))).toThrow("zepsuty.toml");
});

test("cargoVersion rzuca błąd, gdy [package] nie ma version", () => {
  expect(() => cargoVersion(file("bez-wersji.toml", '[package]\nname = "x"\n'))).toThrow("bez-wersji.toml");
});
