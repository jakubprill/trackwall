import type { Group } from "three";
import { cylinder, flatRing, light, unpickable } from "./kit.ts";

/**
 * The light pillar over a session that is waiting for you or ended with an error (ADR-33), the same in every scene style
 * (ADR-104): the only element on the dashboard this loud, visible from anywhere in the scene.
 */

/** Height of the light pillar above the session. */
const BEACON_HEIGHT = 2.6;

/** A light pillar and a ring that rises along it and fades; returns the animation. */
export function addBeacon(group: Group, color: string): (elapsed: number) => void {
  const shaft = unpickable(cylinder([0.045, 0.1], BEACON_HEIGHT, 12, light(color, 0.25), [0, BEACON_HEIGHT / 2 + 0.05, 0]));
  const rising = flatRing(0.14, 0.012, 24, light(color, 0.9));
  group.add(shaft, rising);
  return (t) => {
    const progress = (t * 0.6) % 1;
    rising.position.y = 0.1 + progress * (BEACON_HEIGHT - 0.2);
    rising.material.opacity = 0.9 * (1 - progress);
    shaft.material.opacity = 0.18 + 0.14 * Math.sin(t * 4);
  };
}
