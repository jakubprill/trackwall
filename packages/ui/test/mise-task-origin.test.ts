import { describe, expect, test } from "bun:test";
import { miseTaskOriginLabel } from "../src/lib/mise-task-origin.ts";

describe("mise task origin", () => {
  test("a mise task from a file git tracks is labelled repo", () => {
    expect(miseTaskOriginLabel({ origin: "repo", source: "mise.toml" })).toEqual({
      label: "repo",
      local: false,
      title: "Defined in mise.toml, which is in the repo's git",
    });
  });

  test("a mise task from a file git does not keep is labelled local and stands out", () => {
    expect(miseTaskOriginLabel({ origin: "local", source: "mise.local.toml" })).toEqual({
      label: "local",
      local: true,
      title: "Defined in mise.local.toml, which git does not keep: only this clone has it",
    });
  });

  test("a mise task from the user's global config is labelled outside repo with its full path", () => {
    expect(miseTaskOriginLabel({ origin: "outside", source: "/home/dev/.config/mise/config.toml" })?.title).toBe(
      "Defined in /home/dev/.config/mise/config.toml, outside the repo",
    );
  });

  test("a mise task whose origin is unknown gets no label", () => {
    expect(miseTaskOriginLabel({ origin: null, source: null })).toBeNull();
  });
});
