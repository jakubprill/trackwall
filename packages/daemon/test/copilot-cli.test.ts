import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COPILOT_CLI_VERSION, copilotCliVersion } from "../scripts/copilot-cli.ts";

const NIGHTLY = fileURLToPath(new URL("../../../.github/workflows/nightly.yml", import.meta.url));

const EXACT = ["1.0.104", "1.0.104-3", "10.20.30-0.unstable.r4"];
const NOT_EXACT = ["latest", "^1.0.104", "1.0", "../1.0.104", "1.0.104/../x", "1.0.104; rm -rf /"];

describe("the Copilot CLI version of the contract tests (ADR-67)", () => {
  test("is the pinned one when TRACKWALL_COPILOT_CLI is not set or empty", () => {
    expect(copilotCliVersion({})).toBe(COPILOT_CLI_VERSION);
    expect(copilotCliVersion({ TRACKWALL_COPILOT_CLI: "" })).toBe(COPILOT_CLI_VERSION);
  });

  test("is the one TRACKWALL_COPILOT_CLI names, also a prerelease", () => {
    for (const wanted of EXACT) expect(copilotCliVersion({ TRACKWALL_COPILOT_CLI: wanted })).toBe(wanted);
  });

  test("refuses a dist-tag, a range or a path, which would reach the registry URL and the cache path", () => {
    for (const wanted of NOT_EXACT) {
      expect(() => copilotCliVersion({ TRACKWALL_COPILOT_CLI: wanted })).toThrow(
        `TRACKWALL_COPILOT_CLI="${wanted}" is not an exact version`,
      );
    }
  });

  test("the nightly workflow lets through the same versions before it puts one into an issue title", () => {
    const pattern = readFileSync(NIGHTLY, "utf8").match(/\[\[ "\$version" =~ (\S+) \]\]/)?.[1];
    if (pattern === undefined) throw new Error(`no version check in ${NIGHTLY}`);
    const nightly = new RegExp(pattern);
    expect(EXACT.filter((v) => nightly.test(v))).toEqual(EXACT);
    expect(NOT_EXACT.filter((v) => nightly.test(v))).toEqual([]);
  });
});
