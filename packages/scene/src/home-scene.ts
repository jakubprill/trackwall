import {
  Clickable,
  disposeObject3D,
  type Engine,
  euler,
  Hoverable,
  KeyedEntities,
  Label,
  Position,
  Rotation,
  Scale,
  uniform,
  Visual,
} from "@pawnjs/core";
import type { Entity } from "koota";
import { QuadraticBezierCurve3, Vector3 } from "three";
import { repoHasLabel, sessionHasLabel } from "./home-labels.ts";
import {
  DAEMON_KEY,
  type HomeKey,
  type HomeLink,
  type HomeModel,
  type HomeRepo,
  type HomeSession,
  isHomeKey,
  parseHomeKey,
  repoKey,
  sessionKey,
} from "./home-model.ts";
import { daemonCore } from "./models/daemon-core.ts";
import type { HomeVisual } from "./models/kit.ts";
import { LINK_TUBES, type LinkEmphasis, type LinkVisual, linkTube, TETHER_TUBE } from "./models/link-tube.ts";
import { repoLook, repoModel } from "./models/repo-model.ts";
import { sectorArc } from "./models/sector-arc.ts";
import { sessionPod } from "./models/session-pod.ts";
import { sessionTrack } from "./models/session-track.ts";
import { type OrbitLayout, orbitLayout, REPO_RADIUS, SESSION_RADIUS } from "./orbit-layout.ts";
import { assertScenePalette, type ScenePalette, sessionStateColor } from "./palette.ts";
import { repoKind } from "./repo-kind.ts";

/**
 * Scena pulpitu na silniku Pawn (ADR-33, §5.5). `apply` przyjmuje kolejne migawki pulpitu i trzyma jedną encję na
 * obiekt (`KeyedEntities`): nowy obiekt dostaje encję, zniknięty ją traci, każdy staje tam, gdzie wypada w nowym
 * układzie, a model buduje się od nowa tylko wtedy, gdy zmieniło się coś, co widać. Silnik, kamerę, wskaźnik
 * i etykiety daje wołający, więc ta sama scena działa w oknie i w teście bez przeglądarki.
 */

/** Obiekt, który dostaje etykietę; jej treść pisze UI. */
export type LabelTarget = { kind: "repo"; key: HomeKey; repo: HomeRepo } | { kind: "session"; key: HomeKey; session: HomeSession };

export interface HomeSceneOptions {
  /** Kolory w `#rrggbb` (`ScenePalette`); inny zapis to błąd przy tworzeniu sceny. */
  palette: ScenePalette;
  /**
   * `false` przy `prefers-reduced-motion`: modele stoją w pozie z chwili 0, stan mówią tylko kolor i kształt. Zmiana
   * ustawienia w trakcie działania wymaga nowej sceny.
   */
  motion: boolean;
  /** Klik: scena sama podświetla obiekt i jego połączenia (`focus`), a UI pokazuje szczegóły. */
  onSelect?: (key: HomeKey) => void;
  /** Dwuklik: przejście do sesji albo repo. */
  onOpen?: (key: HomeKey) => void;
  /** Wskaźnik wszedł na obiekt albo z niego zszedł (`null`), także gdy wskazany obiekt zniknął z migawki. */
  onHover?: (key: HomeKey | null) => void;
  /** Element etykiety; bez tej funkcji scena nie dodaje etykiet. */
  createLabel?: (target: LabelTarget) => HTMLElement;
}

/** Wysokość drona sesji nad podłogą. */
const SESSION_Y = 0.55;
/** Wysokość, na której przewód sesji dochodzi do repo. */
const TETHER_END_Y = 0.4;
/** Wysokość przewodów połączeń. */
const LINK_Y = 0.12;
/** Punkt kontrolny krzywej połączenia to środek cięciwy razy ta wartość: 1 to prosta cięciwa, 0 to łuk przez środek. */
const LINK_BEND = 0.2;
const FOCUS_SCALE = 1.12;
const LABEL_OFFSET: Record<LabelTarget["kind"], number> = { repo: 1.05, session: 0.5 };

interface Node {
  signature: string;
  visual: HomeVisual;
  labelSignature: string | null;
  offs: Array<() => void>;
}

interface Placement {
  position: { x: number; y: number; z: number };
  /** Kąt na pierścieniu: model obraca się przodem do środka. */
  angle?: number;
}

const ORIGIN: Placement = { position: { x: 0, y: 0, z: 0 } };

export class HomeScene {
  readonly #engine: Engine;
  readonly #options: HomeSceneOptions;
  readonly #entities: KeyedEntities<string>;
  readonly #nodes = new Map<string, Node>();
  /** Przewody połączeń z grafu, po kluczu encji, do podświetlania przy wyborze. */
  readonly #links = new Map<string, { link: HomeLink; visual: LinkVisual }>();
  /** Repo każdej sesji z ostatniej migawki: wybór sesji podświetla połączenia jej repo. */
  readonly #sessionRepos = new Map<string, string>();
  readonly #removeSystem: () => void;
  #focus: HomeKey | null = null;
  #hovered: HomeKey | null = null;

  constructor(engine: Engine, options: HomeSceneOptions) {
    assertScenePalette(options.palette);
    this.#engine = engine;
    this.#options = options;
    this.#entities = new KeyedEntities<string>(engine, { release: (entity, key) => this.#release(entity, key) });
    this.#removeSystem = options.motion
      ? engine.addSystem(({ elapsed }) => {
          for (const node of this.#nodes.values()) node.visual.animate?.(elapsed);
        })
      : () => {};
  }

  /** Encja obiektu, np. do skierowania na nią kamery (`CameraRig.focus`). */
  entity(key: HomeKey): Entity | undefined {
    return this.#entities.get(key);
  }

  apply(model: HomeModel): void {
    const layout = orbitLayout(model);
    const keep = new Set<string>();
    this.#putCenter(keep, model, layout);
    this.#putRepos(keep, model, layout);
    this.#putSessions(keep, model, layout);
    for (const link of model.links) this.#putLink(keep, link, layout);
    this.#entities.retain(keep);
    this.focus(this.#focus && this.#nodes.has(this.#focus) ? this.#focus : null);
  }

  /** Podświetla obiekt i jego połączenia; `null` wraca do widoku całości. */
  focus(key: HomeKey | null): void {
    this.#focus = key;
    const repo = this.#focusRepo(key);
    for (const { link, visual } of this.#links.values()) {
      const emphasis: LinkEmphasis = repo === null ? "normal" : link.from === repo || link.to === repo ? "lit" : "dim";
      visual.setEmphasis(emphasis);
    }
    for (const nodeKey of this.#nodes.keys()) {
      const target = parseHomeKey(nodeKey);
      const entity = this.#entities.get(nodeKey);
      if (entity && target && target.kind !== "daemon") entity.set(Scale, uniform(nodeKey === key ? FOCUS_SCALE : 1));
    }
  }

  dispose(): void {
    this.#removeSystem();
    // Zasoby zwalniane wprost, a nie przez `release`, bo `KeyedEntities.clear()` pomija go po zamknięciu silnika.
    for (const node of this.#nodes.values()) {
      for (const off of node.offs) off();
      disposeObject3D(node.visual.object);
    }
    this.#nodes.clear();
    this.#links.clear();
    this.#sessionRepos.clear();
    this.#entities.clear();
  }

  #focusRepo(key: HomeKey | null): string | null {
    const target = key === null ? null : parseHomeKey(key);
    if (target?.kind === "repo") return target.id;
    if (target?.kind === "session") return this.#sessionRepos.get(target.id) ?? null;
    return null;
  }

  #putCenter(keep: Set<string>, model: HomeModel, layout: OrbitLayout): void {
    const { palette } = this.#options;
    this.#put(keep, DAEMON_KEY, model.daemonRunning, ORIGIN, () => daemonCore(model.daemonRunning, palette));
    this.#put(keep, "track", SESSION_RADIUS, ORIGIN, () => sessionTrack(SESSION_RADIUS, palette));
    for (const [i, sector] of layout.sectors.entries()) {
      this.#put(keep, `sector:${i}`, sector, ORIGIN, () => sectorArc(REPO_RADIUS + 0.7, sector.start, sector.span, palette));
    }
  }

  #putRepos(keep: Set<string>, model: HomeModel, layout: OrbitLayout): void {
    for (const repo of model.repos) {
      const at = layout.repos.get(repo.id);
      if (!at) throw new Error(`Repo ${repo.id} nie ma miejsca w układzie pulpitu`);
      const key = repoKey(repo.id);
      const look = repoLook(repo, repoKind(repo.layer, model.layerCount));
      const place = { position: { x: at.x, y: 0, z: at.z }, angle: at.angle };
      this.#put(keep, key, look, place, () => repoModel(look, this.#options.palette));
      this.#setLabel(key, repoHasLabel(repo) ? { kind: "repo", key, repo } : null);
    }
  }

  #putSessions(keep: Set<string>, model: HomeModel, layout: OrbitLayout): void {
    const { palette } = this.#options;
    this.#sessionRepos.clear();
    for (const session of model.sessions) {
      const at = layout.sessions.get(session.id);
      const repoAt = layout.repos.get(session.repo);
      if (!at || !repoAt) continue;
      this.#sessionRepos.set(session.id, session.repo);
      const key = sessionKey(session.id);
      this.#put(keep, key, session, { position: { x: at.x, y: SESSION_Y, z: at.z } }, () => sessionPod(session, palette));
      this.#setLabel(key, sessionHasLabel(session) ? { kind: "session", key, session } : null);
      // Przewód od drona do repo: kolor stanu sesji, żeby błąd było widać także przy repo.
      const color = sessionStateColor(session.state, palette);
      this.#put(keep, `tether:${session.id}`, { at, repoAt, color }, ORIGIN, () => {
        const curve = new QuadraticBezierCurve3(
          new Vector3(at.x, SESSION_Y, at.z),
          new Vector3((at.x + repoAt.x) / 2, SESSION_Y, (at.z + repoAt.z) / 2),
          new Vector3(repoAt.x, TETHER_END_Y, repoAt.z),
        );
        return linkTube(curve, TETHER_TUBE, color);
      });
    }
  }

  #putLink(keep: Set<string>, link: HomeLink, layout: OrbitLayout): void {
    const from = layout.repos.get(link.from);
    const to = layout.repos.get(link.to);
    if (!from || !to) return;
    const key = `link:${link.from}>${link.to}:${link.kind}`;
    this.#put(keep, key, { from, to, kind: link.kind }, ORIGIN, () => {
      const curve = new QuadraticBezierCurve3(
        new Vector3(from.x, LINK_Y, from.z),
        new Vector3(((from.x + to.x) / 2) * LINK_BEND, LINK_Y, ((from.z + to.z) / 2) * LINK_BEND),
        new Vector3(to.x, LINK_Y, to.z),
      );
      const visual = linkTube(curve, LINK_TUBES[link.kind], this.#options.palette.primary);
      this.#links.set(key, { link, visual });
      return visual;
    });
  }

  /**
   * Zapewnia encję obiektu, zostawia ją w `keep` i stawia ją w `place`. Model buduje od nowa tylko wtedy, gdy zmienił
   * się `look`, czyli wszystko, od czego zależy wygląd; samo przesunięcie modelu nie przebudowuje.
   */
  #put(keep: Set<string>, key: string, look: unknown, place: Placement, build: () => HomeVisual): void {
    keep.add(key);
    const entity = this.#entities.ensure(key, () => this.#spawn(key));
    if (!entity) throw new Error(`Nie udało się utworzyć encji ${key} na pulpicie`);
    entity.set(Position, place.position);
    if (place.angle !== undefined) entity.set(Rotation, euler({ y: -place.angle - Math.PI / 2 }));
    const signature = JSON.stringify(look);
    const existing = this.#nodes.get(key);
    if (existing?.signature === signature) return;
    const visual = build();
    visual.animate?.(0);
    if (existing) disposeObject3D(existing.visual.object);
    if (entity.has(Visual)) entity.set(Visual, visual.object);
    else entity.add(Visual(visual.object));
    this.#nodes.set(key, {
      signature,
      visual,
      labelSignature: existing?.labelSignature ?? null,
      offs: existing?.offs ?? this.#listen(entity, key),
    });
  }

  #spawn(key: string): Entity {
    const entity = this.#engine.spawn(Position, Rotation, Scale(uniform(1)));
    if (isHomeKey(key)) entity.add(Hoverable, Clickable);
    return entity;
  }

  #listen(entity: Entity, key: string): Array<() => void> {
    if (!isHomeKey(key)) return [];
    const { events } = this.#engine;
    const { onSelect, onOpen } = this.#options;
    return [
      events.on(entity, "click", () => {
        this.focus(key);
        onSelect?.(key);
      }),
      events.on(entity, "doubleclick", () => onOpen?.(key)),
      events.on(entity, "pointerenter", () => this.#hover(key)),
      events.on(entity, "pointerleave", () => this.#hover(null)),
    ];
  }

  #hover(key: HomeKey | null): void {
    this.#hovered = key;
    this.#options.onHover?.(key);
  }

  /** Etykieta zmienia się tylko wtedy, gdy zmieniło się to, co UI w niej pisze. */
  #setLabel(key: HomeKey, target: LabelTarget | null): void {
    const node = this.#nodes.get(key);
    const entity = this.#entities.get(key);
    const { createLabel } = this.#options;
    if (!node || !entity || !createLabel) return;
    const signature = target === null ? null : JSON.stringify(target);
    if (node.labelSignature === signature) return;
    node.labelSignature = signature;
    if (entity.has(Label)) entity.remove(Label);
    if (target) entity.add(Label({ element: createLabel(target), offset: { y: LABEL_OFFSET[target.kind] } }));
  }

  #release(entity: Entity, key: string): void {
    const node = this.#nodes.get(key);
    this.#nodes.delete(key);
    this.#links.delete(key);
    for (const off of node?.offs ?? []) off();
    if (node) disposeObject3D(node.visual.object);
    if (key === this.#hovered) this.#hover(null);
    entity.destroy();
  }
}
