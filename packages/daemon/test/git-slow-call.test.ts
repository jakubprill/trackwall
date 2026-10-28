import { describe, expect, test } from "bun:test";
import { slowCallNote } from "../src/modules/vcs/git.ts";

describe("the log line of a slow git call", () => {
  test("a call that took 5 s or more, waiting for a slot included, names the command, the repo and both times", () => {
    expect(slowCallNote("git log", "/projects/orders", 3_200.4, 1_900.6)).toBe(
      "git log in /projects/orders took 1901 ms after 3200 ms waiting for a slot",
    );
  });

  test("a call under 5 s gets no line", () => {
    expect(slowCallNote("git status", "/projects/orders", 1_000, 3_999)).toBeUndefined();
  });
});
