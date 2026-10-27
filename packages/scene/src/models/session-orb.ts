import { Group } from "three";
import type { HomeSession } from "../home-model.ts";
import { type ScenePalette, sessionStateColor } from "../palette.ts";
import { addBeacon } from "./beacon.ts";
import { glow, type HomeVisual, light, sphere } from "./kit.ts";

/**
 * A Copilot session in the `orbs` style (ADR-104): a small glowing sphere in the state colour. A session waiting for you or
 * with an error has the same light pillar as the drone of the `holo` style, because that is what you look for on the scene.
 */
export function sessionOrb(session: HomeSession, palette: ScenePalette): HomeVisual {
  const root = new Group();
  const group = new Group();
  root.add(group);
  const color = sessionStateColor(session.state, palette);
  group.add(sphere(0.13, light(color)), glow(color, 0.9, 0, 0.8));
  const beacon = session.state === "attention" || session.state === "error" ? addBeacon(group, color) : null;
  return { object: root, animate: (t) => beacon?.(t) };
}
