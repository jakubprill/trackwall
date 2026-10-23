import { describe, expect, test } from "bun:test";
import { evidenceLabel } from "../src/cards.ts";

describe("karta repo", () => {
  test("dowód z linią to ścieżka:linia, a bez linii sama ścieżka", () => {
    expect(evidenceLabel({ path: "pom.xml", line: 12 })).toBe("pom.xml:12");
    expect(evidenceLabel({ path: "Dockerfile", line: null })).toBe("Dockerfile");
  });
});
