import type { ScenePalette } from "../palette.ts";
import { flatArc, type HomeVisual, light, unpickable } from "./kit.ts";

/**
 * A layer arc outside the repo ring. A flat ring with an angle is `RingGeometry`, because Pawn's `Shape` has no arc yet
 * (reported to Pawn).
 */
export function sectorArc(radius: number, start: number, span: number, palette: ScenePalette): HomeVisual {
  return { object: unpickable(flatArc(radius, radius + 0.06, start, span, light(palette.primary, 0.5))) };
}
