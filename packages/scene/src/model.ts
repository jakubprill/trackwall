/**
 * Entry point `@trackwall/scene/model`: keys, dashboard snapshot, palette and style types without three.js and Pawn, for the UI
 * outside the dashboard canvas (§5.5), so that the engine stays in a lazily loaded chunk.
 */
export * from "./home-model.ts";
export type { ScenePalette } from "./palette.ts";
export * from "./scene-style.ts";
