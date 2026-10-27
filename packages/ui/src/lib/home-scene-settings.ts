import { SCENE_LABEL_MODES, SCENE_STYLES, type SceneLabelMode, type SceneStyle } from "@trackwall/scene/model";

/**
 * How Home draws its 3D scene on this computer (ADR-104): the style of the models and which objects have a label. A
 * display preference of this computer, not of the workspace (a weak laptop at work and a fast Mac at home can differ), so
 * it lives in `localStorage` like the supervisor pin. Storage can be missing, refuse access or hold an old value, so
 * anything but a known value reads as the default, and a write that fails is forgotten.
 */
export interface HomeSceneSettings {
  style: SceneStyle;
  labels: SceneLabelMode;
}

const STYLE_KEY = "trackwall.home.style";
const LABELS_KEY = "trackwall.home.labels";

/** Holograms with every repo named: the richest look, and the one the scene was designed around. */
const DEFAULT_HOME_SCENE_SETTINGS: HomeSceneSettings = { style: "holo", labels: "all" };

export function readHomeSceneSettings(storage: () => Pick<Storage, "getItem">): HomeSceneSettings {
  try {
    const store = storage();
    return {
      style: known(SCENE_STYLES, store.getItem(STYLE_KEY)) ?? DEFAULT_HOME_SCENE_SETTINGS.style,
      labels: known(SCENE_LABEL_MODES, store.getItem(LABELS_KEY)) ?? DEFAULT_HOME_SCENE_SETTINGS.labels,
    };
  } catch {
    return DEFAULT_HOME_SCENE_SETTINGS;
  }
}

export function saveHomeSceneSettings(storage: () => Pick<Storage, "setItem">, settings: HomeSceneSettings): void {
  try {
    const store = storage();
    store.setItem(STYLE_KEY, settings.style);
    store.setItem(LABELS_KEY, settings.labels);
  } catch {
    // Home keeps the setting until the window closes; only the next start does not remember it.
  }
}

function known<T extends string>(values: readonly T[], value: string | null): T | null {
  return values.find((v) => v === value) ?? null;
}
