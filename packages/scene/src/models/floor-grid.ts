import { type LineBasicMaterial, PolarGridHelper } from "three";
import type { ScenePalette } from "../palette.ts";
import { glow, type HomeVisual, unpickable } from "./kit.ts";

/**
 * The floor under the rings (ADR-104): a faint polar grid like a radar screen and a soft light in the middle, so the models
 * stand on something and the scene does not float on the window's background.
 */
export function floorGrid(radius: number, palette: ScenePalette): HomeVisual {
  const grid = new PolarGridHelper(radius, 24, 8, 96, palette.primary, palette.primary);
  const material = grid.material as LineBasicMaterial;
  material.transparent = true;
  material.opacity = 0.08;
  material.depthWrite = false;
  grid.position.y = -0.01;
  grid.add(glow(palette.primary, radius * 2.4, 0, 0.12));
  return { object: unpickable(grid) };
}
