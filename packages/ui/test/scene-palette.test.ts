import { describe, expect, test } from "bun:test";
import { rgbHex } from "../src/lib/scene-palette.ts";

describe("scene colours from tokens", () => {
  test("a canvas pixel is a #rrggbb colour with leading zeros in the components", () => {
    expect(rgbHex(0, 128, 255)).toBe("#0080ff");
    expect(rgbHex(5, 10, 15)).toBe("#050a0f");
  });
});
