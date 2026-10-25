import { describe, expect, test } from "bun:test";
import { HOME_CAMERA_FOV, HOME_CAMERA_MAX_DISTANCE, homeCameraDistance, homeCameraPosition } from "../src/lib/home-camera.ts";

/** Half the frame width at the camera distance: how much of the scene is visible from the centre to the edge. */
function halfWidth(width: number, height: number): number {
  return homeCameraDistance(width, height) * Math.tan((HOME_CAMERA_FOV * Math.PI) / 360) * (width / height);
}

describe("dashboard framing", () => {
  test("in a narrow canvas the camera moves back so that the repo ring (radius 6.6) fits the width", () => {
    expect(halfWidth(576, 800)).toBeGreaterThan(7.3);
    expect(halfWidth(376, 800)).toBeGreaterThan(7.3);
    expect(homeCameraDistance(376, 800)).toBeGreaterThan(homeCameraDistance(576, 800));
  });

  test("in a wide canvas the height decides, and a very narrow canvas does not move the camera back beyond the limit", () => {
    expect(homeCameraDistance(1600, 800)).toBe(homeCameraDistance(800, 800));
    expect(homeCameraDistance(40, 800)).toBe(HOME_CAMERA_MAX_DISTANCE);
  });

  test("the position lies at that distance from the scene centre, above it and in front of it", () => {
    const { x, y, z } = homeCameraPosition(20);
    expect(Math.hypot(x, y, z)).toBeCloseTo(20);
    expect(x).toBe(0);
    expect(y).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
  });
});
