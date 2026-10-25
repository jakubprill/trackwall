import { Mesh, RingGeometry } from "three";
import type { ScenePalette } from "../palette.ts";
import { type HomeVisual, light, unpickable } from "./kit.ts";

/** The inner session track: a thin ring the drones stand on (ADR-33). */
export function sessionTrack(radius: number, palette: ScenePalette): HomeVisual {
  const geometry = new RingGeometry(radius - 0.012, radius + 0.012, 128).rotateX(-Math.PI / 2);
  return { object: unpickable(new Mesh(geometry, light(palette.idle, 0.9))) };
}
