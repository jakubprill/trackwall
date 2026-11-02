import { describe, expect, test } from "bun:test";
import { cutText } from "../src/cut-text.ts";

describe("cutText", () => {
  test("a text within the limit stays as it is", () => {
    expect(cutText("short", 5)).toBe("short");
  });

  test("a longer text is cut to the limit with an ellipsis as its last character", () => {
    expect(cutText("abcdefgh", 5)).toBe("abcd…");
  });

  test("a cut never splits a character outside the BMP, so the text stays valid and within the limit", () => {
    const cut = cutText("abc😀def", 5);
    expect(cut).toBe("abc…");
    expect(cut.length).toBeLessThanOrEqual(5);
  });
});
