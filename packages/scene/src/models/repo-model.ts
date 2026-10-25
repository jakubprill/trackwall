import { Group, Mesh, PlaneGeometry } from "three";
import type { HomeRepo, HomeRepoState } from "../home-model.ts";
import { repoStateColor, type ScenePalette } from "../palette.ts";
import type { RepoKind } from "../repo-kind.ts";
import { box, cylinder, flatRing, type HomeVisual, light, outline, solid } from "./kit.ts";

/**
 * Repo model (ADR-33): a slab with a state stripe, on it the solid for its kind (from the layer), next to it bars for the
 * number of changes or commits to pull, and a ring with a spark while a mise task runs. Everything you need to know
 * without reading is colour or shape; the repo name is in the label and the preview card.
 */

/** Maximum number of bars next to the slab; more changes mean "a lot" anyway. */
const MAX_COUNT_BARS = 5;
/** Front of the model: +z in model space; the scene turns it to the centre of the ring. */
const FRONT_Z = 0.345;

/** Everything a repo's look depends on; the scene rebuilds the model only when this value changes. */
export interface RepoLook {
  kind: RepoKind;
  state: HomeRepoState;
  bars: number;
  taskRunning: boolean;
}

export function repoLook(repo: HomeRepo, kind: RepoKind): RepoLook {
  const counted = repo.state === "changed" || repo.state === "behind";
  return {
    kind,
    state: repo.state,
    bars: counted ? Math.min(repo.count, MAX_COUNT_BARS) : 0,
    taskRunning: repo.runningTask !== null,
  };
}

type Part = (look: RepoLook, color: string, palette: ScenePalette) => HomeVisual;

export function repoModel(look: RepoLook, palette: ScenePalette): HomeVisual {
  const group = new Group();
  const animations: Array<(elapsed: number) => void> = [];
  const add = (visual: HomeVisual) => {
    group.add(visual.object);
    if (visual.animate) animations.push(visual.animate);
  };
  // One state colour for the stripe, the solid and its lights: a clean repo is calm, the rest shows its state.
  const color = repoStateColor(look.state, palette);
  add(plate(color, palette));
  add(BODIES[look.kind](look, color, palette));
  add(countBars(look, color));
  if (look.taskRunning) add(runningHalo(palette));
  return {
    object: group,
    animate: (t) => {
      for (const animation of animations) animation(t);
    },
  };
}

function plate(color: string, palette: ScenePalette): HomeVisual {
  const group = new Group();
  const base = box([0.9, 0.08, 0.68], solid(palette.plate), [0, 0.04, 0]);
  group.add(base, outline(base, palette.primary, 0.25));
  group.add(box([0.6, 0.035, 0.02], light(color), [0, 0.06, FRONT_Z]));
  return { object: group };
}

/** Bars exist only for `changed` and `behind`, so they have the repo state colour. */
function countBars(look: RepoLook, color: string): HomeVisual {
  const group = new Group();
  for (let i = 0; i < look.bars; i++) {
    const height = 0.05 + i * 0.03;
    group.add(box([0.05, height, 0.05], light(color), [0.38, 0.12 + height / 2, 0.24 - i * 0.07]));
  }
  return { object: group };
}

function runningHalo(palette: ScenePalette): HomeVisual {
  const group = new Group();
  group.add(flatRing(0.58, 0.012, 48, light(palette.primary, 0.9), 0.05));
  const spark = box([0.04, 0.04, 0.04], light(palette.primary), [0.58, 0.07, 0]);
  group.add(spark);
  return {
    object: group,
    animate: (t) => {
      spark.position.set(Math.cos(t * 1.4) * 0.58, 0.07, Math.sin(t * 1.4) * 0.58);
    },
  };
}

/** Entry: a terminal, that is a screen on a stand glowing in the state colour; an unavailable repo flickers. */
const entry: Part = (look, color, palette) => {
  const group = new Group();
  const tilt = -0.12;
  group.add(cylinder([0.03, 0.05], 0.22, 8, solid(palette.body), [0, 0.19, -0.05]));
  const frame = box([0.66, 0.42, 0.05], solid(palette.body), [0, 0.48, -0.05]);
  frame.rotation.x = tilt;
  group.add(frame, outline(frame, palette.primary, 0.35));
  const screen = new Mesh(new PlaneGeometry(0.58, 0.34), light(color, 0.85));
  screen.position.set(0, 0.48, -0.022);
  screen.rotation.x = tilt;
  group.add(screen);
  for (let i = 0; i < 3; i++) {
    const line = box([0.3 - i * 0.07, 0.025, 0.002], light(palette.muted, 0.35), [-0.1, 0.56 - i * 0.07, -0.018]);
    line.rotation.x = tilt;
    group.add(line);
  }
  if (look.state !== "unavailable") return { object: group };
  return {
    object: group,
    animate: (t) => {
      screen.material.opacity = Math.sin(t * 13) > 0.6 ? 0.8 : 0.4;
    },
  };
};

/** Gateway: a cylinder with an antenna and a ring in the state colour. */
const gateway: Part = (_look, color, palette) => {
  const group = new Group();
  const hub = cylinder([0.22, 0.26], 0.34, 8, solid(palette.body), [0, 0.25, 0]);
  group.add(hub, outline(hub, palette.primary, 0.35));
  const ring = flatRing(0.3, 0.018, 32, light(color, 0.9), 0.3);
  group.add(ring);
  group.add(
    cylinder([0.012, 0.012], 0.36, 4, solid(palette.body), [-0.13, 0.58, 0]),
    cylinder([0.012, 0.012], 0.26, 4, solid(palette.body), [0.13, 0.53, 0]),
  );
  const tip = cylinder([0.03, 0.03], 0.03, 8, light(color, 0.9), [-0.13, 0.77, 0]);
  group.add(tip);
  return {
    object: group,
    animate: (t) => {
      ring.rotation.z = t * 0.8;
      tip.material.opacity = 0.5 + 0.4 * Math.abs(Math.sin(t * 2));
    },
  };
};

/** Backend: a rack with LEDs; the top LED is the state, the second blinks while a mise task runs, the bottom two are decoration. */
const backend: Part = (look, color, palette) => {
  const group = new Group();
  const body = box([0.56, 0.62, 0.44], solid(palette.body), [0, 0.39, 0]);
  group.add(body, outline(body, palette.primary, 0.35));
  const led = (row: number, ledColor: string) => box([0.4, 0.035, 0.01], light(ledColor, 0.95), [0, 0.58 - row * 0.12, 0.226]);
  const busy = led(1, look.taskRunning ? palette.primary : palette.plate);
  group.add(led(0, color), busy, led(2, palette.plate), led(3, palette.plate));
  group.add(box([0.5, 0.02, 0.38], solid(palette.plate), [0, 0.71, 0]));
  if (!look.taskRunning) return { object: group };
  return {
    object: group,
    animate: (t) => {
      busy.material.opacity = Math.sin(t * 9) > 0 ? 1 : 0.4;
    },
  };
};

/** Library: a transparent box with a spinning core. */
const library: Part = (_look, color, palette) => {
  const group = new Group();
  const shell = box([0.46, 0.46, 0.46], solid(palette.body, 0, 0.35), [0, 0.31, 0]);
  group.add(shell, outline(shell, palette.primary, 0.5));
  const core = box([0.18, 0.18, 0.18], light(color), [0, 0.31, 0]);
  group.add(core);
  return {
    object: group,
    animate: (t) => {
      core.rotation.set(t * 0.4, t * 0.6, 0);
    },
  };
};

const BODIES: Record<RepoKind, Part> = { entry, gateway, backend, library };
