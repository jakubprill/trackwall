import { Group, Mesh, PlaneGeometry } from "three";
import type { HomeRepo, HomeRepoState } from "../home-model.ts";
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

/** Wszystko, od czego zależy wygląd repo; scena buduje model od nowa tylko przy zmianie tej wartości. */
export interface RepoLook {
  kind: RepoKind;
  state: HomeRepoState;
  bars: number;
  hasMise: boolean;
  taskRunning: boolean;
}

export function repoLook(repo: HomeRepo, kind: RepoKind): RepoLook {
  const counted = repo.state === "changed" || repo.state === "behind";
  return {
    kind,
    state: repo.state,
    bars: counted ? Math.min(repo.count, MAX_COUNT_BARS) : 0,
    hasMise: repo.hasMise,
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
  // Jeden kolor stanu dla paska, bryły i jej świateł: czyste repo jest spokojne, reszta mówi stanem.
  const color = repoStateColor(look.state, palette);
  add(plate(color, palette));
  add(BODIES[look.kind](look, color, palette));
  add(countBars(look, color));
  if (!look.hasMise) group.add(box([0.16, 0.02, 0.16], solid(palette.muted, 0.2), [-0.33, 0.09, -0.24]));
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

/** Słupki są tylko przy `changed` i `behind`, więc mają kolor stanu repo. */
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

/** Wejście: terminal, czyli ekran na stojaku, świecący kolorem stanu; niedostępne repo migocze. */
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

/** Brama: walec z anteną i pierścieniem w kolorze stanu. */
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

/** Serwis: szafa z diodami; górna dioda to stan, druga mruga, gdy działa task mise, dwie dolne są ozdobą. */
const service: Part = (look, color, palette) => {
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

/** Biblioteka: przezroczysta skrzynka z obracającym się rdzeniem. */
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

const BODIES: Record<RepoKind, Part> = { entry, gateway, service, library };
