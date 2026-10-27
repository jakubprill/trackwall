/**
 * How the dashboard draws its objects (ADR-104), chosen in Settings > App on each computer: `holo` builds every repo kind
 * as a hologram on a pad (the default), `orbs` draws glowing spheres, lighter for a weak graphics card. The layout,
 * colours and labels are the same in both.
 */
export const SCENE_STYLES = ["holo", "orbs"] as const;
export type SceneStyle = (typeof SCENE_STYLES)[number];

/**
 * Which objects have a label (ADR-104): `all` names every repo (a clean one quietly), `needs-you` only what the "Needs you" queue
 * lists: repos that are not clean and sessions that wait for you or have an error.
 */
export const SCENE_LABEL_MODES = ["all", "needs-you"] as const;
export type SceneLabelMode = (typeof SCENE_LABEL_MODES)[number];
