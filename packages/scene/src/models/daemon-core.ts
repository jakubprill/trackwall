import { Group } from "three";
import type { HomeSession } from "../home-model.ts";
import type { ScenePalette } from "../palette.ts";
import { box, cylinder, flatArc, flatRing, glow, type HomeVisual, light, outline, solid, unpickable } from "./kit.ts";

/**
 * The daemon in the centre of the rings (ADR-33, ADR-104): a reactor with a ring of slots like in a HUD, two rings turning
 * around its core and, on the floor, an arc of the sessions: working ones in the primary colour, the ones waiting for you
 * in the warning colour, out of all of them. The core glows while the daemon runs, and goes dark (only the body stays) when
 * the UI has lost its connection to it.
 */

const SLOTS = 24;
const ARC_RADIUS = 1.75;
/** Gap between the working and the waiting part of the session arc, in radians. */
const ARC_GAP = 0.04;

/** Everything the reactor's look depends on; the scene rebuilds it only when this value changes. */
export interface CoreLook {
  running: boolean;
  working: number;
  waiting: number;
  total: number;
}

export function coreLook(running: boolean, sessions: readonly HomeSession[]): CoreLook {
  return {
    running,
    working: sessions.filter((s) => s.state === "working").length,
    waiting: sessions.filter((s) => s.state === "attention").length,
    total: sessions.length,
  };
}

export function daemonCore(look: CoreLook, palette: ScenePalette): HomeVisual {
  const { running } = look;
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
  group.add(slots, sessionArc(look, palette));
  if (!running) return { object: group };
  const outer = flatRing(0.78, 0.02, 64, light(palette.primary, 0.8), 0.6);
  const inner = flatRing(0.62, 0.02, 64, light(palette.primary, 0.6), 0.85);
  group.add(outer, inner, glow(palette.primary, 4, 0.6, 0.45));
  return {
    object: group,
    animate: (t) => {
      slots.rotation.y = t * 0.15;
      core.material.opacity = 0.65 + 0.15 * Math.sin(t * 1.3);
      outer.rotation.set(Math.PI / 2 + Math.sin(t * 0.6) * 0.15, 0, t * 0.5);
      inner.rotation.set(Math.PI / 2, Math.cos(t * 0.5) * 0.18, -t * 0.8);
    },
  };
}

/** The session arc on the floor, starting at the back of the scene like the layout's first layer. */
function sessionArc(look: CoreLook, palette: ScenePalette): Group {
  const group = new Group();
  const arc = (start: number, span: number, color: string, opacity: number) =>
    unpickable(flatArc(ARC_RADIUS - 0.05, ARC_RADIUS + 0.05, start, span, light(color, opacity)));
  group.add(arc(0, Math.PI * 2, palette.primary, 0.1));
  if (look.total === 0) return group;
  const start = -Math.PI / 2;
  const working = (look.working / look.total) * Math.PI * 2;
  const waiting = (look.waiting / look.total) * Math.PI * 2;
  if (working > 0) group.add(arc(start, working - (waiting > 0 ? ARC_GAP : 0), palette.primary, 0.9));
  if (waiting > 0) group.add(arc(start + working, waiting, palette.warning, 0.9));
  group.position.y = 0.02;
  return group;
}
