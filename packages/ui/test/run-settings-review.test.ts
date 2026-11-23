import { describe, expect, test } from "bun:test";
import type { RunSettingsChange, TaskRunSettings } from "@trackwall/protocol";
import { runSettingsAcceptance } from "../src/lib/run-settings-review.ts";

function review(...changes: RunSettingsChange[]): TaskRunSettings {
  return { guarded: true, matches: false, baselineKnown: true, changes, digest: "1".repeat(64) };
}

const hook: RunSettingsChange = { place: ".git/hooks/pre-commit", change: "added", content: "#!/bin/sh\n", acceptable: true };

describe("accepting changed git settings", () => {
  test("changes the user can read in full can be accepted at once", () => {
    expect(runSettingsAcceptance(review(hook), false)).toEqual({ canAccept: true, blocked: [], hidden: [] });
  });

  test("a change whose text is not shown can be accepted only after the user says they read it in the repo", () => {
    const header = {
      place: ".git/config http.https://example.com/.extraheader",
      change: "added",
      content: null,
      acceptable: true,
    } as const;
    expect(runSettingsAcceptance(review(hook, header), false)).toEqual({ canAccept: false, blocked: [], hidden: [header.place] });
    expect(runSettingsAcceptance(review(hook, header), true).canAccept).toBe(true);
  });

  test("a deleted place has no text to read and does not wait for that", () => {
    expect(runSettingsAcceptance(review({ ...hook, change: "removed", content: null }), false).canAccept).toBe(true);
  });

  test("a change that can make git run a program Trackwall does not check cannot be accepted at all", () => {
    const include = { place: ".git/config include.path", change: "added", content: "/tmp/x", acceptable: false } as const;
    expect(runSettingsAcceptance(review(include), true)).toEqual({ canAccept: false, blocked: [include.place], hidden: [] });
  });
});
