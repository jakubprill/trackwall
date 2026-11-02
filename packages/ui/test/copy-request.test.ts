import { expect, test } from "bun:test";
import { copyReady, copyRequestPreview } from "../src/lib/copy-request.ts";

test("the copy request strip names the text by its first line that is not blank and counts its lines and characters", () => {
  expect(copyRequestPreview("mvn verify")).toEqual({ firstLine: "mvn verify", lines: 1, characters: 10 });
  expect(copyRequestPreview("\n  cd orders\r\nmvn verify\n")).toEqual({ firstLine: "cd orders", lines: 4, characters: 25 });
  // Characters, not UTF-16 units: "zażółć" is six.
  expect(copyRequestPreview("zażółć")).toEqual({ firstLine: "zażółć", lines: 1, characters: 6 });
  expect(copyRequestPreview("   ")).toEqual({ firstLine: "", lines: 1, characters: 3 });
});

test("Copy is ready only for the request whose wait has passed, whatever object the session list brings it in", () => {
  expect(copyReady("r1", { id: "r1" })).toBe(true);
  // The agent replaced the request during or after the wait: the new one waits again.
  expect(copyReady("r1", { id: "r2" })).toBe(false);
  expect(copyReady(undefined, { id: "r1" })).toBe(false);
  expect(copyReady("r1", null)).toBe(false);
});
