import type { HomeRepoState, HomeSessionState } from "./home-model.ts";

/**
 * Scene colours come from the UI tokens (`packages/ui/src/index.css`, ADR-16), read by the UI when the scene is created,
 * so the scene has no palette of its own that would drift from the rest of the application. The tokens are in `oklch`,
 * which three.js does not read, so the UI passes them converted to sRGB as `#rrggbb`; the scene checks this on creation.
 */
export interface ScenePalette {
  /** `--primary`: work in progress, selection, connections. */
  primary: string;
  /** `--warning`: waiting for you, local changes. */
  warning: string;
  /** `--destructive`: error, repo unavailable. */
  destructive: string;
  /** `--muted-foreground`: ended sessions, clean repos, text on screens. */
  muted: string;
  /** `--secondary` without transparency: idle session, the session track. */
  idle: string;
  /** `--card` without transparency: model bodies. */
  body: string;
  /** `--background`: slabs under the models. */
  plate: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function assertScenePalette(palette: ScenePalette): void {
  for (const [name, color] of Object.entries(palette)) {
    if (!HEX_COLOR.test(color)) throw new Error(`Scene colour ${name} must be #rrggbb, but is ${color}`);
  }
}

export function repoStateColor(state: HomeRepoState, palette: ScenePalette): string {
  if (state === "changed") return palette.warning;
  if (state === "behind") return palette.primary;
  if (state === "unavailable") return palette.destructive;
  // A repo whose status is still on its way is there, but says nothing yet (ADR-113).
  if (state === "loading") return palette.idle;
  // Not `idle`: that is nearly the background, and a clean repo must still stand out on the ring (ADR-104).
  return palette.muted;
}

const SESSION_STATE_COLORS: Record<HomeSessionState, keyof ScenePalette> = {
  working: "primary",
  attention: "warning",
  idle: "idle",
  error: "destructive",
  done: "muted",
};

export function sessionStateColor(state: HomeSessionState, palette: ScenePalette): string {
  return palette[SESSION_STATE_COLORS[state]];
}
