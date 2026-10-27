import { Group } from "three";
import type { HomeSession } from "../home-model.ts";
import { type ScenePalette, sessionStateColor } from "../palette.ts";
import { cylinder, flatRing, glow, type HomeVisual, light, outline, solid, unpickable } from "./kit.ts";

/**
 * A Copilot session as a drone in the `holo` style (ADR-33, ADR-104): a hexagonal body with a glow and a ring that spins
 * while the session is working.
 * A session that is waiting for you or ended with an error has a light pillar with a rising ring, visible from anywhere
 * in the scene; it is the only element on the dashboard this loud.
 */

/** Height of the light pillar above the drone. */
const BEACON_HEIGHT = 2.6;

export function sessionPod(session: HomeSession, palette: ScenePalette): HomeVisual {
  // The scene copies the entity position to the object every frame, so the inner group sways, not the entity's object.
  const root = new Group();
  const group = new Group();
  root.add(group);
  const phase = [...session.id].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const color = sessionStateColor(session.state, palette);
  const body = cylinder([0.17, 0.2], 0.14, 6, solid(palette.body), [0, 0, 0]);
  group.add(body, outline(body, color, 0.9));
  group.add(cylinder([0.09, 0.09], 0.02, 12, light(color), [0, 0.08, 0]));
  const ring = flatRing(0.29, 0.014, 6, light(color, 0.9));
  group.add(ring, glow(color, 1.1, 0, 0.5));
  const beacon = session.state === "attention" || session.state === "error" ? addBeacon(group, color) : null;
  return {
    object: root,
    animate: (t) => {
      group.position.y = 0.05 * Math.sin(t * 1.6 + phase);
      if (session.state === "working") ring.rotation.z = t * 2.2;
      if (beacon) beacon(t);
    },
  };
}

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
