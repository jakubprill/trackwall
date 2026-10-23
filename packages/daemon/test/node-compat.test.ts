import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

/** ADR-1: daemon ma działać też pod samym Node 22 (usuwanie typów bez flag), nie tylko pod Bun. */
describe("zgodność z Node", () => {
  test("node ładuje wszystkie pliki daemona i wypisuje wersję", () => {
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    expect(execFileSync("node", [main, "--version"], { encoding: "utf8" }).trim()).toBe(VERSION);
  });
});
