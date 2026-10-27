import { Group, Mesh, PlaneGeometry } from "three";
import type { HomeRepo, HomeRepoState } from "../home-model.ts";
import { repoStateColor, type ScenePalette } from "../palette.ts";
import type { RepoKind } from "../repo-kind.ts";
import { box, cylinder, flatArc, flatRing, glass, glow, type HomeVisual, light, outline, solid, tickRing, unpickable } from "./kit.ts";

/**
 * Repo model in the `holo` style (ADR-33, ADR-104): the solid of its kind (from the layer) as a hologram, a translucent body
 * with light edges and a core glowing in the state colour, on a pad. Around the pad an arc in the state colour grows with
 * the number of changes or commits to pull, and a dial scale turns, fast while a mise task runs. Everything you need to know
 * without reading is colour or shape; the repo name is in the label and the preview card.
 */

/** The level at which the state arc closes; more changes mean "a lot" anyway. */
export const MAX_REPO_LEVEL = 5;
/** Front of the model: +z in model space; the scene turns it to the centre of the ring. */
const FRONT_Z = 0.236;
/** Radius of the state arc around the pad. */
const ARC_RADIUS = 0.7;

/** Everything a repo's look depends on; the scene rebuilds the model only when this value changes. */
export interface RepoLook {
  kind: RepoKind;
  state: HomeRepoState;
  /** Changes or commits to pull, up to `MAX_REPO_LEVEL`; 0 for the other states. */
  level: number;
  taskRunning: boolean;
}

export function repoLook(repo: HomeRepo, kind: RepoKind): RepoLook {
  const counted = repo.state === "changed" || repo.state === "behind";
  return {
    kind,
    state: repo.state,
    level: counted ? Math.min(repo.count, MAX_REPO_LEVEL) : 0,
    taskRunning: repo.runningTask !== null,
  };
}

type Part = (look: RepoLook, color: string, palette: ScenePalette) => HomeVisual;

export function repoModel(look: RepoLook, palette: ScenePalette): HomeVisual {
  return assemble([pad(look, palette), BODIES[look.kind](look, repoStateColor(look.state, palette), palette)]);
}

/** One model of several parts, each with its own animation. */
function assemble(parts: readonly HomeVisual[]): HomeVisual {
  const group = new Group();
  for (const part of parts) group.add(part.object);
  const animations = parts.flatMap((part) => (part.animate ? [part.animate] : []));
  return {
    object: group,
    animate: (t) => {
      for (const animation of animations) animation(t);
    },
  };
}

/** Share of the state arc: a counted state starts at a sliver and closes at `MAX_REPO_LEVEL`; an unavailable repo is a full ring. */
function stateArcShare(look: RepoLook): number {
  if (look.state === "unavailable") return 1;
  return look.level === 0 ? 0 : 0.15 + (0.85 * look.level) / MAX_REPO_LEVEL;
}

function pad(look: RepoLook, palette: ScenePalette): HomeVisual {
  const group = new Group();
  const color = repoStateColor(look.state, palette);
  const base = cylinder([0.5, 0.56], 0.08, 6, solid(palette.body, 0.05), [0, 0.04, 0]);
  group.add(base, outline(base, palette.primary, 0.4));
  group.add(unpickable(flatArc(ARC_RADIUS - 0.03, ARC_RADIUS + 0.03, 0, Math.PI * 2, light(palette.primary, 0.12))));
  const share = stateArcShare(look);
  if (share > 0) {
    const arc = flatArc(ARC_RADIUS - 0.03, ARC_RADIUS + 0.03, -Math.PI / 2, Math.PI * 2 * share, light(color, 0.95));
    arc.position.y = 0.005;
    group.add(unpickable(arc));
    group.add(glow(color, 2.2, 0.35, 0.35));
  }
  group.add(flatRing(0.8, 0.008, 64, light(palette.primary, 0.35), 0.01));
  const ticks = unpickable(tickRing(0.87, 36, 0.05, 0.014, light(palette.primary, look.taskRunning ? 0.9 : 0.3)));
  ticks.position.y = 0.012;
  group.add(ticks);
  const speed = look.taskRunning ? 0.9 : 0.12;
  return {
    object: group,
    animate: (t) => {
      ticks.rotation.y = t * speed;
    },
  };
}

/** Entry: a terminal, a screen on a stand glowing in the state colour; an unavailable repo flickers. */
const entry: Part = (look, color, palette) => {
  const group = new Group();
  const tilt = -0.15;
  group.add(cylinder([0.03, 0.06], 0.3, 8, glass(palette.body, palette.primary, 0.9), [0, 0.23, 0]));
  const frame = box([0.86, 0.54, 0.05], glass(palette.body, palette.primary), [0, 0.66, 0]);
  frame.rotation.x = tilt;
  group.add(frame, outline(frame, palette.primary, 0.9));
  const screen = new Mesh(new PlaneGeometry(0.76, 0.44), light(color, 0.55));
  screen.position.set(0, 0.66, 0.03);
  screen.rotation.x = tilt;
  group.add(screen);
  for (let i = 0; i < 4; i++) {
    const line = box([0.42 - i * 0.08, 0.03, 0.002], light(i === 0 ? color : palette.muted, 0.8), [-0.12, 0.8 - i * 0.08, 0.036]);
    line.rotation.x = tilt;
    group.add(line);
  }
  if (look.state !== "unavailable") return { object: group };
  return {
    object: group,
    animate: (t) => {
      screen.material.opacity = Math.sin(t * 13) > 0.6 ? 0.8 : 0.25;
    },
  };
};

/** Gateway: a hexagonal hub with a core in the state colour, a tilted spinning ring and two antennas. */
const gateway: Part = (_look, color, palette) => {
  const group = new Group();
  const hub = cylinder([0.26, 0.3], 0.46, 6, glass(palette.body, palette.primary), [0, 0.31, 0]);
  group.add(hub, outline(hub, palette.primary, 0.9));
  group.add(cylinder([0.1, 0.1], 0.36, 12, light(color), [0, 0.31, 0]));
  const ring = flatRing(0.42, 0.018, 48, light(palette.primary, 0.9), 0.36);
  ring.rotation.x = Math.PI / 2 - 0.25;
  group.add(ring);
  for (const [x, height] of [
    [-0.14, 0.42],
    [0.14, 0.3],
  ] as const) {
    group.add(cylinder([0.012, 0.012], height, 4, solid(palette.body), [x, 0.54 + height / 2, 0]));
    group.add(glow(palette.primary, 0.28, 0.54 + height, 0.9));
  }
  return {
    object: group,
    animate: (t) => {
      ring.rotation.z = t * 0.9;
    },
  };
};

/** Backend: a rack with LED strips on its front; the top strip is the state, the second blinks while a mise task runs. */
const backend: Part = (look, color, palette) => {
  const group = new Group();
  const body = box([0.58, 0.8, 0.46], glass(palette.body, palette.primary, 0.45), [0, 0.48, 0]);
  group.add(body, outline(body, palette.primary, 0.9));
  const led = (row: number, ledColor: string) => box([0.44, 0.04, 0.01], light(ledColor, 0.95), [0, 0.74 - row * 0.14, FRONT_Z]);
  const busy = led(1, look.taskRunning ? palette.primary : palette.plate);
  group.add(led(0, color), busy, led(2, palette.plate), led(3, palette.plate));
  group.add(box([0.62, 0.03, 0.5], light(color, 0.8), [0, 0.895, 0]));
  if (!look.taskRunning) return { object: group };
  return {
    object: group,
    animate: (t) => {
      busy.material.opacity = Math.sin(t * 9) > 0 ? 0.95 : 0.3;
    },
  };
};

/** Library: a faceted shell with a spinning core in the state colour. */
const library: Part = (_look, color, palette) => {
  const group = new Group();
  const shell = cylinder([0.34, 0.34], 0.52, 6, glass(palette.body, palette.primary, 0.25), [0, 0.42, 0]);
  group.add(shell, outline(shell, palette.primary, 0.85));
  const core = box([0.2, 0.2, 0.2], light(color), [0, 0.42, 0]);
  group.add(core, glow(color, 0.9, 0.42, 0.6));
  return {
    object: group,
    animate: (t) => {
      core.rotation.set(t * 0.5, t * 0.7, 0);
    },
  };
};

const BODIES: Record<RepoKind, Part> = { entry, gateway, backend, library };
