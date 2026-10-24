import { describe, expect, test } from "bun:test";
import { HOME_CAMERA_FOV, HOME_CAMERA_MAX_DISTANCE, homeCameraDistance, homeCameraPosition } from "../src/lib/home-camera.ts";

/** Połowa szerokości kadru w odległości kamery: tyle sceny widać od środka do krawędzi. */
function halfWidth(width: number, height: number): number {
  return homeCameraDistance(width, height) * Math.tan((HOME_CAMERA_FOV * Math.PI) / 360) * (width / height);
}

describe("kadr pulpitu", () => {
  test("w wąskim płótnie kamera odsuwa się tak, że pierścień repo (promień 6,6) mieści się na szerokość", () => {
    expect(halfWidth(576, 800)).toBeGreaterThan(7.3);
    expect(halfWidth(376, 800)).toBeGreaterThan(7.3);
    expect(homeCameraDistance(376, 800)).toBeGreaterThan(homeCameraDistance(576, 800));
  });

  test("w szerokim płótnie decyduje wysokość, a bardzo wąskie płótno nie odsuwa kamery dalej niż limit", () => {
    expect(homeCameraDistance(1600, 800)).toBe(homeCameraDistance(800, 800));
    expect(homeCameraDistance(40, 800)).toBe(HOME_CAMERA_MAX_DISTANCE);
  });

  test("pozycja leży w tej odległości od środka sceny, nad nią i przed nią", () => {
    const { x, y, z } = homeCameraPosition(20);
    expect(Math.hypot(x, y, z)).toBeCloseTo(20);
    expect(x).toBe(0);
    expect(y).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
  });
});
