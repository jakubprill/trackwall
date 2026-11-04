import type { Group } from "three";
import type { HomeServiceState } from "../home-model.ts";
import { type ScenePalette, serviceStateColor } from "../palette.ts";
import { flatArc, light, unpickable } from "./kit.ts";

/**
 * The repo's running service on the floor around its model (ADR-191), the same in every scene style: four arcs in the
 * service's colour, steady while it answers, breathing while it starts or stops, blinking when it fails. Nothing is
 * drawn while no service runs.
 */

const ARCS = 4;
/** The share of each quarter an arc covers; the gaps tell it from the repo's own state arc. */
const ARC_SHARE = 0.7;

/** Adds the arcs at `radius` on the floor; returns their animation, `undefined` for a ready service, which does not move. */
export function addServiceRing(
  group: Group,
  service: HomeServiceState,
  palette: ScenePalette,
  radius: number,
): ((t: number) => void) | undefined {
  const color = serviceStateColor(service, palette);
  const quarter = (Math.PI * 2) / ARCS;
  const arcs = Array.from({ length: ARCS }, (_, i) => {
    const arc = unpickable(flatArc(radius - 0.025, radius + 0.025, i * quarter, quarter * ARC_SHARE, light(color, 0.9)));
    arc.position.y = 0.015;
    group.add(arc);
    return arc;
  });
  if (service === "ready") return undefined;
  return (t) => {
    const opacity = service === "failing" ? (Math.sin(t * 9) > 0 ? 0.95 : 0.2) : 0.45 + 0.4 * Math.sin(t * 3);
    for (const arc of arcs) arc.material.opacity = opacity;
  };
}
