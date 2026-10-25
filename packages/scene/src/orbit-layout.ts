import type { HomeModel, HomeRepo, HomeSession } from "./home-model.ts";

/**
 * The "Orbit" layout (ADR-33): repos on the outer ring in layer arcs, sessions on the inner track opposite their repo,
 * the daemon in the centre. A pure function of angles and radii, without three.js, so it is tested directly.
 * The first layer lies at the back of the scene (angle −π/2), the next ones go clockwise, and repos without connections
 * in the graph (`layer: null`) get the last arc.
 */

export const REPO_RADIUS = 6.6;
export const SESSION_RADIUS = 3.3;
/** Gap between layer arcs, in radians. */
const LAYER_GAP = 0.34;
/** The largest angular spacing between sessions of one repo; smaller with many sessions, so they stay by their repo. */
const SESSION_SPREAD = 0.14;
/** The share of a repo's angle its sessions may take; the rest separates them from the neighbour's sessions. */
const SESSION_SHARE = 0.8;

interface OrbitPoint {
  angle: number;
  x: number;
  z: number;
}

interface OrbitSector {
  start: number;
  span: number;
}

export interface OrbitLayout {
  sectors: OrbitSector[];
  repos: Map<string, OrbitPoint>;
  /** A session of a repo outside the model (for example the repo vanished from the folder) has no place on the track and is not drawn. */
  sessions: Map<string, OrbitPoint>;
}

const point = (angle: number, radius: number): OrbitPoint => ({ angle, x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });

export function orbitLayout(model: Pick<HomeModel, "layerCount" | "repos" | "sessions">): OrbitLayout {
  const misplaced = model.repos.find((r) => r.layer !== null && (!Number.isInteger(r.layer) || r.layer < 0 || r.layer >= model.layerCount));
  if (misplaced) throw new Error(`Repo ${misplaced.id} has layer ${misplaced.layer}, outside the ${model.layerCount} dashboard layers`);

  // An empty layer gets neither an arc nor a gap, so as not to leave a hole in the ring.
  const groups = [...Array.from({ length: model.layerCount }, (_, layer) => layer), null]
    .map((layer) => model.repos.filter((r) => r.layer === layer))
    .filter((repos) => repos.length > 0);
  const sessionsByRepo = new Map<string, HomeSession[]>();
  for (const s of model.sessions) sessionsByRepo.set(s.repo, [...(sessionsByRepo.get(s.repo) ?? []), s]);
  const span = Math.PI * 2 - LAYER_GAP * groups.length;
  const total = model.repos.length;
  const layout: OrbitLayout = { sectors: [], repos: new Map(), sessions: new Map() };
  let start = -Math.PI / 2 - (groups[0] ? (span * groups[0].length) / total / 2 : 0);
  for (const repos of groups) {
    const sectorSpan = (span * repos.length) / total;
    layout.sectors.push({ start, span: sectorSpan });
    placeSector(layout, repos, start, sectorSpan / repos.length, sessionsByRepo);
    start += sectorSpan + LAYER_GAP;
  }
  return layout;
}

function placeSector(
  layout: OrbitLayout,
  repos: readonly HomeRepo[],
  start: number,
  slot: number,
  sessionsByRepo: Map<string, HomeSession[]>,
): void {
  for (const [i, repo] of repos.entries()) {
    const angle = start + slot * (i + 0.5);
    layout.repos.set(repo.id, point(angle, REPO_RADIUS));
    const own = sessionsByRepo.get(repo.id) ?? [];
    const spread = Math.min(SESSION_SPREAD, (slot * SESSION_SHARE) / own.length);
    for (const [j, s] of own.entries()) layout.sessions.set(s.id, point(angle + (j - (own.length - 1) / 2) * spread, SESSION_RADIUS));
  }
}
