import { expect, test } from "bun:test";
import { versions } from "../scripts/lib.ts";

test("wersje daemona, tauri.conf i Cargo.toml są równe", () => {
  expect(new Set(Object.values(versions())).size).toBe(1);
});
