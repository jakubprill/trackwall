import { describe, expect, test } from "bun:test";
import { evidenceLabel } from "../src/evidence.ts";

describe("repo card", () => {
  test("evidence with a line is path:line, and without a line just the path", () => {
    expect(evidenceLabel({ path: "pom.xml", line: 12 })).toBe("pom.xml:12");
    expect(evidenceLabel({ path: "Dockerfile", line: null })).toBe("Dockerfile");
  });
});
