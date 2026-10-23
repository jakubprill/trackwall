import { describe, expect, test } from "bun:test";
import { evidenceLabel } from "../src/lib/card.ts";

describe("karta repo w UI", () => {
  test("dowód z linią i bez linii", () => {
    expect(evidenceLabel({ path: "pom.xml", line: 12 })).toBe("pom.xml:12");
    expect(evidenceLabel({ path: "Dockerfile", line: null })).toBe("Dockerfile");
  });
});
