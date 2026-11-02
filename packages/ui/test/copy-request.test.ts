import { expect, test } from "bun:test";
import { copyRequestPreview } from "../src/lib/copy-request.ts";

test("the copy request strip names the text by its first line that is not blank and counts its lines and characters", () => {
  expect(copyRequestPreview("mvn verify")).toEqual({ firstLine: "mvn verify", lines: 1, characters: 10 });
  expect(copyRequestPreview("\n  cd orders\r\nmvn verify\n")).toEqual({ firstLine: "cd orders", lines: 4, characters: 25 });
  // Characters, not UTF-16 units: "zażółć" is six.
  expect(copyRequestPreview("zażółć")).toEqual({ firstLine: "zażółć", lines: 1, characters: 6 });
  expect(copyRequestPreview("   ")).toEqual({ firstLine: "", lines: 1, characters: 3 });
});
