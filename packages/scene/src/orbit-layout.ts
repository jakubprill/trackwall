import type { HomeModel } from "./home-model.ts";

/**
 * Układ „Orbit” (ADR-33): repo na zewnętrznym pierścieniu w łukach warstw, sesje na wewnętrznym torze naprzeciw
 * swojego repo, daemon w środku. Czysta funkcja kątów i promieni, bez three.js, więc testowana wprost.
 * Pierwsza warstwa leży z tyłu sceny (kąt −π/2), kolejne idą zgodnie z ruchem wskazówek zegara.
 */

export const REPO_RADIUS = 6.6;
export const SESSION_RADIUS = 3.3;
/** Przerwa między łukami warstw, w radianach. */
const LAYER_GAP = 0.34;
/** Odstęp kątowy między sesjami jednego repo. */
const SESSION_SPREAD = 0.14;

interface OrbitPoint {
  angle: number;
  x: number;
  z: number;
}

interface OrbitSector {
  label: string;
  start: number;
  span: number;
}

export interface OrbitLayout {
  sectors: OrbitSector[];
  repos: Map<string, OrbitPoint>;
  /** Sesja repo spoza modelu (np. repo zniknęło z folderu) nie ma miejsca na torze i nie jest rysowana. */
  sessions: Map<string, OrbitPoint>;
}

const point = (angle: number, radius: number): OrbitPoint => ({ angle, x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });

export function orbitLayout(model: Pick<HomeModel, "layers" | "repos" | "sessions">): OrbitLayout {
  const byLayer = model.layers.map((_, layer) => model.repos.filter((r) => r.layer === layer));
  const misplaced = model.repos.find((r) => !Number.isInteger(r.layer) || r.layer < 0 || r.layer >= model.layers.length);
  if (misplaced) throw new Error(`Repo ${misplaced.id} ma warstwę ${misplaced.layer} spoza ${model.layers.length} warstw pulpitu`);

  // Pusta warstwa nie dostaje łuku ani przerwy, żeby nie zostawiać dziury w pierścieniu.
  const used = byLayer.flatMap((repos, layer) => (repos.length > 0 ? [{ layer, repos }] : []));
  const total = model.repos.length;
  const span = Math.PI * 2 - LAYER_GAP * used.length;
  const sectors: OrbitSector[] = [];
  const repos = new Map<string, OrbitPoint>();
  let start = -Math.PI / 2 - (used[0] ? (span * used[0].repos.length) / total / 2 : 0);
  for (const { layer, repos: list } of used) {
    const sectorSpan = (span * list.length) / total;
    sectors.push({ label: model.layers[layer] ?? "", start, span: sectorSpan });
    for (const [i, repo] of list.entries()) repos.set(repo.id, point(start + (sectorSpan * (i + 0.5)) / list.length, REPO_RADIUS));
    start += sectorSpan + LAYER_GAP;
  }

  const sessions = new Map<string, OrbitPoint>();
  for (const repo of model.repos) {
    const at = repos.get(repo.id);
    const own = model.sessions.filter((s) => s.repo === repo.id);
    if (!at) continue;
    for (const [i, s] of own.entries()) sessions.set(s.id, point(at.angle + (i - (own.length - 1) / 2) * SESSION_SPREAD, SESSION_RADIUS));
  }
  return { sectors, repos, sessions };
}
