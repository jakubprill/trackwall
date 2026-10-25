import { Mesh, RingGeometry } from "three";
import type { ScenePalette } from "../palette.ts";
import { type HomeVisual, light, unpickable } from "./kit.ts";

/**
 * A layer arc outside the repo ring. A flat ring with an angle is `RingGeometry`, because Pawn's `Shape` has no arc yet
 * (reported to Pawn).
 */
export function sectorArc(radius: number, start: number, span: number, palette: ScenePalette): HomeVisual {
  // RingGeometry lies in the XY plane with the angle from +X to +Y; turned horizontal, +Y becomes −Z, so the scene angle
  // (from +X to +Z) is the geometry angle with a minus sign.
  const geometry = new RingGeometry(radius, radius + 0.06, 64, 1, -start - span, span).rotateX(-Math.PI / 2);
  return { object: unpickable(new Mesh(geometry, light(palette.primary, 0.5))) };
}
