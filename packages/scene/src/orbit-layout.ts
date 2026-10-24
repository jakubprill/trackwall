import type { HomeModel, HomeRepo, HomeSession } from "./home-model.ts";

/**
 * Układ „Orbit” (ADR-33): repo na zewnętrznym pierścieniu w łukach warstw, sesje na wewnętrznym torze naprzeciw
 * swojego repo, daemon w środku. Czysta funkcja kątów i promieni, bez three.js, więc testowana wprost.
 * Pierwsza warstwa leży z tyłu sceny (kąt −π/2), kolejne idą zgodnie z ruchem wskazówek zegara, a repo bez połączeń
 * w grafie (`layer: null`) mają ostatni łuk.
 */

export const REPO_RADIUS = 6.6;
export const SESSION_RADIUS = 3.3;
/** Przerwa między łukami warstw, w radianach. */
const LAYER_GAP = 0.34;
/** Największy odstęp kątowy między sesjami jednego repo; przy wielu sesjach mniejszy, żeby zostały przy swoim repo. */
const SESSION_SPREAD = 0.14;
/** Część kąta repo, którą mogą zająć jego sesje; reszta oddziela je od sesji sąsiada. */
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
  /** Sesja repo spoza modelu (np. repo zniknęło z folderu) nie ma miejsca na torze i nie jest rysowana. */
  sessions: Map<string, OrbitPoint>;
}

const point = (angle: number, radius: number): OrbitPoint => ({ angle, x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });

export function orbitLayout(model: Pick<HomeModel, "layerCount" | "repos" | "sessions">): OrbitLayout {
  const misplaced = model.repos.find((r) => r.layer !== null && (!Number.isInteger(r.layer) || r.layer < 0 || r.layer >= model.layerCount));
  if (misplaced) throw new Error(`Repo ${misplaced.id} ma warstwę ${misplaced.layer} spoza ${model.layerCount} warstw pulpitu`);

  // Pusta warstwa nie dostaje łuku ani przerwy, żeby nie zostawiać dziury w pierścieniu.
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
