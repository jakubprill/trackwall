import { Group } from "three";
import type { ScenePalette } from "../palette.ts";
import { box, cylinder, type HomeVisual, light, outline, solid } from "./kit.ts";

/**
 * Daemon w środku pierścieni (ADR-33): reaktor z pierścieniem slotów jak w HUD. Rdzeń świeci, gdy daemon działa,
 * a gaśnie (zostaje sam korpus), gdy UI straciło z nim połączenie.
 */

const SLOTS = 24;

export function daemonCore(running: boolean, palette: ScenePalette, motion: boolean): HomeVisual {
  const group = new Group();
  const disc = cylinder([1.25, 1.35], 0.12, 48, solid(palette.plate), [0, 0.06, 0]);
  group.add(disc, outline(disc, palette.accent, 0.2));
  const column = cylinder([0.36, 0.42], 0.7, 12, solid(palette.body), [0, 0.47, 0]);
  group.add(column, outline(column, palette.accent, 0.35));
  const core = cylinder([0.24, 0.24], 0.5, 24, light(running ? palette.accent : palette.plate, 0.55), [0, 0.5, 0]);
  group.add(core, cylinder([0.48, 0.48], 0.05, 24, solid(palette.plate), [0, 0.84, 0]));
  const slots = new Group();
  for (let i = 0; i < SLOTS; i++) {
    const angle = (i / SLOTS) * Math.PI * 2;
    const slot = box([0.22, 0.05, 0.08], light(running && i % 4 === 0 ? palette.accent : palette.plate), [
      Math.cos(angle) * 0.95,
      0.16,
      Math.sin(angle) * 0.95,
    ]);
    slot.rotation.y = -angle;
    slots.add(slot);
  }
  group.add(slots);
  if (!motion || !running) return { object: group };
  return {
    object: group,
    animate: (t) => {
      slots.rotation.y = t * 0.15;
      core.material.opacity = 0.45 + 0.15 * Math.sin(t * 1.3);
    },
  };
}
