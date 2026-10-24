import { Group, Mesh, PlaneGeometry } from "three";
import type { HomeRepo } from "../home-model.ts";
import { repoStateColor, type ScenePalette } from "../palette.ts";
import type { RepoKind } from "../repo-kind.ts";
import { box, cylinder, flatRing, type HomeVisual, light, outline, solid } from "./kit.ts";

/**
 * Model repo (ADR-33): płyta z paskiem stanu, na niej bryła rodzaju z warstwy, obok słupki liczby zmian albo
 * commitów do pobrania, szara płytka, gdy brak mise, i pierścień z iskrą, gdy działa task mise. Wszystko, co trzeba
 * wiedzieć bez czytania, jest kolorem albo kształtem; nazwa repo jest w etykiecie i karcie podglądu.
 */

/** Najwięcej słupków obok płyty; więcej zmian i tak znaczy „dużo”. */
const MAX_COUNT_BARS = 5;
/** Przód modelu: +z w układzie modelu, scena obraca go do środka pierścienia. */
const FRONT_Z = 0.345;

type Part = (repo: HomeRepo, palette: ScenePalette, motion: boolean) => HomeVisual;

export function repoModel(repo: HomeRepo, kind: RepoKind, palette: ScenePalette, motion: boolean): HomeVisual {
  const group = new Group();
  const animations: Array<(elapsed: number) => void> = [];
  const add = (visual: HomeVisual) => {
    group.add(visual.object);
    if (visual.animate) animations.push(visual.animate);
  };
  add(plate(repo, palette));
  add(BODIES[kind](repo, palette, motion));
  add(countBars(repo, palette));
  if (!repo.hasMise) group.add(box([0.16, 0.02, 0.16], solid(palette.muted, 0.2), [-0.33, 0.09, -0.24]));
  if (repo.runningTask) add(runningHalo(palette, motion));
  if (animations.length === 0) return { object: group };
  return {
    object: group,
    animate: (t) => {
      for (const animation of animations) animation(t);
    },
  };
}

/** Kolor bryły: spokojny akcent dla czystego repo, inaczej kolor stanu. */
function stateAccent(repo: HomeRepo, palette: ScenePalette): string {
  return repo.state === "clean" ? palette.accent : repoStateColor(repo.state, palette);
}

function plate(repo: HomeRepo, palette: ScenePalette): HomeVisual {
  const group = new Group();
  const base = box([0.9, 0.08, 0.68], solid(palette.plate), [0, 0.04, 0]);
  group.add(base, outline(base, palette.accent, 0.25));
  group.add(box([0.6, 0.035, 0.02], light(repoStateColor(repo.state, palette)), [0, 0.06, FRONT_Z]));
  return { object: group };
}

function countBars(repo: HomeRepo, palette: ScenePalette): HomeVisual {
  const group = new Group();
  const color = repo.state === "behind" ? palette.accent : palette.warning;
  const bars = repo.state === "changed" || repo.state === "behind" ? Math.min(repo.count, MAX_COUNT_BARS) : 0;
  for (let i = 0; i < bars; i++) {
    const height = 0.05 + i * 0.03;
    group.add(box([0.05, height, 0.05], light(color), [0.38, 0.12 + height / 2, 0.24 - i * 0.07]));
  }
  return { object: group };
}

function runningHalo(palette: ScenePalette, motion: boolean): HomeVisual {
  const group = new Group();
  group.add(flatRing(0.58, 0.012, 48, light(palette.accent, 0.9), 0.05));
  const spark = box([0.04, 0.04, 0.04], light(palette.accent), [0.58, 0.07, 0]);
  group.add(spark);
  if (!motion) return { object: group };
  return {
    object: group,
    animate: (t) => {
      spark.position.set(Math.cos(t * 1.4) * 0.58, 0.07, Math.sin(t * 1.4) * 0.58);
    },
  };
}

/** Wejście: ekran na stojaku, świecący kolorem stanu; niedostępne repo migocze. */
const terminal: Part = (repo, palette, motion) => {
  const group = new Group();
  const tilt = -0.12;
  group.add(cylinder([0.03, 0.05], 0.22, 8, solid(palette.body), [0, 0.19, -0.05]));
  const frame = box([0.66, 0.42, 0.05], solid(palette.body), [0, 0.48, -0.05]);
  frame.rotation.x = tilt;
  group.add(frame, outline(frame, palette.accent, 0.35));
  const screen = new Mesh(new PlaneGeometry(0.58, 0.34), light(repo.state === "clean" ? palette.plate : stateAccent(repo, palette), 0.85));
  screen.position.set(0, 0.48, -0.022);
  screen.rotation.x = tilt;
  group.add(screen);
  for (let i = 0; i < 3; i++) {
    const line = box([0.3 - i * 0.07, 0.025, 0.002], light(palette.muted, 0.35), [-0.1, 0.56 - i * 0.07, -0.018]);
    line.rotation.x = tilt;
    group.add(line);
  }
  if (repo.state !== "unavailable" || !motion) return { object: group };
  return {
    object: group,
    animate: (t) => {
      screen.material.opacity = Math.sin(t * 13) > 0.6 ? 0.8 : 0.4;
    },
  };
};

/** Druga warstwa: walec z anteną i pierścieniem w kolorze stanu. */
const gateway: Part = (repo, palette, motion) => {
  const group = new Group();
  const color = stateAccent(repo, palette);
  const hub = cylinder([0.22, 0.26], 0.34, 8, solid(palette.body), [0, 0.25, 0]);
  group.add(hub, outline(hub, palette.accent, 0.35));
  const ring = flatRing(0.3, 0.018, 32, light(color, 0.9), 0.3);
  group.add(ring);
  group.add(
    cylinder([0.012, 0.012], 0.36, 4, solid(palette.body), [-0.13, 0.58, 0]),
    cylinder([0.012, 0.012], 0.26, 4, solid(palette.body), [0.13, 0.53, 0]),
  );
  const tip = cylinder([0.03, 0.03], 0.03, 8, light(color, 0.9), [-0.13, 0.77, 0]);
  group.add(tip);
  if (!motion) return { object: group };
  return {
    object: group,
    animate: (t) => {
      ring.rotation.z = t * 0.8;
      tip.material.opacity = 0.5 + 0.4 * Math.abs(Math.sin(t * 2));
    },
  };
};

/** Środek grafu: szafa z diodami; górna dioda to stan, druga mruga, gdy działa task mise. */
const rack: Part = (repo, palette, motion) => {
  const group = new Group();
  const body = box([0.56, 0.62, 0.44], solid(palette.body), [0, 0.39, 0]);
  group.add(body, outline(body, palette.accent, 0.35));
  const leds = [0, 1, 2, 3].map((i) => {
    const color = i === 0 ? stateAccent(repo, palette) : i === 1 && repo.runningTask ? palette.accent : palette.plate;
    const led = box([0.4, 0.035, 0.01], light(color, 0.95), [0, 0.58 - i * 0.12, 0.226]);
    group.add(led);
    return led;
  });
  group.add(box([0.5, 0.02, 0.38], solid(palette.plate), [0, 0.71, 0]));
  const busy = leds[1];
  if (!motion || !repo.runningTask || !busy) return { object: group };
  return {
    object: group,
    animate: (t) => {
      busy.material.opacity = Math.sin(t * 9) > 0 ? 1 : 0.4;
    },
  };
};

/** Biblioteki: przezroczysta skrzynka z obracającym się rdzeniem. */
const crate: Part = (repo, palette, motion) => {
  const group = new Group();
  const color = stateAccent(repo, palette);
  const shell = box([0.46, 0.46, 0.46], solid(palette.body, 0, 0.35), [0, 0.31, 0]);
  group.add(shell, outline(shell, color, 0.7));
  const core = box([0.18, 0.18, 0.18], light(repo.state === "clean" ? palette.idle : color), [0, 0.31, 0]);
  group.add(core);
  if (!motion) return { object: group };
  return {
    object: group,
    animate: (t) => {
      core.rotation.set(t * 0.4, t * 0.6, 0);
    },
  };
};

const BODIES: Record<RepoKind, Part> = { terminal, gateway, rack, crate };
