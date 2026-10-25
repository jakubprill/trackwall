import { Group } from "three";
import type { ScenePalette } from "../palette.ts";
import { box, cylinder, flatRing, type HomeVisual, light, outline, solid } from "./kit.ts";

/**
 * The daemon in the centre of the rings (ADR-33): a reactor with a ring of slots like in a HUD. The core glows through a
 * translucent column while the daemon runs, and goes dark (only the body stays) when the UI has lost its connection to it.
 */

const SLOTS = 24;

export function daemonCore(running: boolean, palette: ScenePalette): HomeVisual {
  const group = new Group();
  const disc = cylinder([1.25, 1.35], 0.12, 48, solid(palette.plate), [0, 0.06, 0]);
  group.add(disc, outline(disc, palette.primary, 0.2));
  const column = cylinder([0.36, 0.42], 0.7, 12, solid(palette.body, 0, 0.35), [0, 0.47, 0]);
  column.material.depthWrite = false;
  group.add(column, outline(column, palette.primary, 0.35));
  const core = cylinder([0.24, 0.24], 0.5, 24, light(running ? palette.primary : palette.plate, 0.75), [0, 0.5, 0]);
  group.add(core, flatRing(0.45, 0.03, 24, solid(palette.plate), 0.84));
  const slots = new Group();
  for (let i = 0; i < SLOTS; i++) {
    const angle = (i / SLOTS) * Math.PI * 2;
    const slot = box([0.22, 0.05, 0.08], light(running && i % 4 === 0 ? palette.primary : palette.plate), [
      Math.cos(angle) * 0.95,
      0.16,
      Math.sin(angle) * 0.95,
    ]);
    slot.rotation.y = -angle;
    slots.add(slot);
  }
  group.add(slots);
  if (!running) return { object: group };
  return {
    object: group,
    animate: (t) => {
      slots.rotation.y = t * 0.15;
      core.material.opacity = 0.65 + 0.15 * Math.sin(t * 1.3);
    },
  };
}
