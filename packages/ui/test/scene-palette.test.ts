import { describe, expect, test } from "bun:test";
import { rgbHex } from "../src/lib/scene-palette.ts";

describe("kolory sceny z tokenów", () => {
  test("piksel z płótna to kolor #rrggbb z zerami na początku składowych", () => {
    expect(rgbHex(0, 128, 255)).toBe("#0080ff");
    expect(rgbHex(5, 10, 15)).toBe("#050a0f");
  });
});
