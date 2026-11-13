import { describe, expect, test } from "bun:test";
import { alwaysAllowedToolLabel, alwaysAllowLabel } from "../src/lib/always-allow.ts";

describe("Always allow in words (ADR-249)", () => {
  test("a shell command reads as the command, an MCP tool as the tool from its server", () => {
    expect(alwaysAllowLabel("shell(npm test)")).toBe("Always allow `npm test` in this repo's tasks");
    expect(alwaysAllowedToolLabel("trackwall(verify_task)")).toBe("verify_task from trackwall");
  });

  test("a pattern of another shape reads as it is", () => {
    expect(alwaysAllowedToolLabel("write")).toBe("write");
  });
});
