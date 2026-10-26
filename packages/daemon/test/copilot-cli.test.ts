import { describe, expect, test } from "bun:test";
import { COPILOT_CLI_VERSION, copilotCliVersion } from "../scripts/copilot-cli.ts";

describe("the Copilot CLI version of the contract tests (ADR-67)", () => {
  test("is the pinned one when TRACKWALL_COPILOT_CLI is not set or empty", () => {
    expect(copilotCliVersion({})).toBe(COPILOT_CLI_VERSION);
    expect(copilotCliVersion({ TRACKWALL_COPILOT_CLI: "" })).toBe(COPILOT_CLI_VERSION);
  });

  test("is the one TRACKWALL_COPILOT_CLI names, also a prerelease", () => {
    expect(copilotCliVersion({ TRACKWALL_COPILOT_CLI: "1.0.104" })).toBe("1.0.104");
    expect(copilotCliVersion({ TRACKWALL_COPILOT_CLI: "1.0.104-3" })).toBe("1.0.104-3");
  });

  test("refuses a dist-tag, a range or a path, which would reach the registry URL and the cache path", () => {
    for (const wanted of ["latest", "^1.0.104", "1.0", "../1.0.104", "1.0.104/../x"]) {
      expect(() => copilotCliVersion({ TRACKWALL_COPILOT_CLI: wanted })).toThrow(
        `TRACKWALL_COPILOT_CLI="${wanted}" is not an exact version`,
      );
    }
  });
});
