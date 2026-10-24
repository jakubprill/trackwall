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
import { repoLabel, sessionLabel } from "./home-labels.ts";
import { DAEMON_KEY, type HomeKey, type HomeLink, type HomeModel, repoKey, sessionKey } from "./home-model.ts";
import { daemonCore } from "./models/daemon-core.ts";
import type { HomeVisual } from "./models/kit.ts";
import { type LinkEmphasis, type LinkVisual, linkTube } from "./models/link-tube.ts";
import { repoModel } from "./models/repo-model.ts";
import { sectorArc } from "./models/sector-arc.ts";
import { sessionPod } from "./models/session-pod.ts";
import { sessionTrack } from "./models/session-track.ts";
import { type OrbitLayout, orbitLayout, REPO_RADIUS, SESSION_RADIUS } from "./orbit-layout.ts";
import { type ScenePalette, sessionStateColor } from "./palette.ts";
import { repoKind } from "./repo-kind.ts";

/**
 * Scena pulpitu na silniku Pawn (ADR-33, §5.5). `apply` przyjmuje kolejne migawki modelu i trzyma jedną encję na
 * obiekt (`KeyedEntities`): nowy obiekt dostaje encję, zniknięty ją traci, a zmieniony dostaje nowy model tylko wtedy,
 * gdy zmieniło się coś, co widać. Silnik, kamerę, wskaźnik i etykiety daje wołający, więc ta sama scena działa
 * w oknie i w teście bez przeglądarki.
 */

export interface HomeSceneOptions {
  palette: ScenePalette;
  /** `false` przy `prefers-reduced-motion`: modele stoją, stan mówią tylko kolor i kształt. */
  motion: boolean;
  onSelect?: (key: HomeKey) => void;
  /** Dwuklik: przejście do sesji albo repo. */
  onOpen?: (key: HomeKey) => void;
  onHover?: (key: HomeKey | null) => void;
  /** Element etykiety; bez tej funkcji scena nie dodaje etykiet. */
  createLabel?: (text: string, key: HomeKey) => HTMLElement;
}

/** Wysokość drona sesji nad podłogą. */
const SESSION_Y = 0.55;
/** Wysokość, na której przewód sesji dochodzi do repo. */
const TETHER_END_Y = 0.4;
/** Wysokość przewodów połączeń. */
const LINK_Y = 0.12;
/** Jak mocno krzywa połączenia jest ściągana do środka pierścienia (0 to cięciwa przez środek). */
const LINK_PULL = 0.2;
const FOCUS_SCALE = 1.12;
const LABEL_OFFSET: Record<"repo" | "session", number> = { repo: 1.05, session: 0.5 };

interface Node {
  signature: string;
  visual: HomeVisual;
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

  constructor(engine: Engine, options: HomeSceneOptions) {
    this.#engine = engine;
    this.#options = options;
    this.#entities = new KeyedEntities<string>(engine, { release: (entity, key) => this.#release(entity, key) });
    this.#removeSystem = engine.addSystem(({ elapsed }) => {
      for (const node of this.#nodes.values()) node.visual.animate?.(elapsed);
    });
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
      const entity = this.#entities.get(nodeKey);
      if (entity && (nodeKey.startsWith("repo:") || nodeKey.startsWith("session:")))
        entity.set(Scale, uniform(nodeKey === key ? FOCUS_SCALE : 1));
    }
  }

  dispose(): void {
    this.#removeSystem();
    this.#entities.clear();
  }

  #focusRepo(key: HomeKey | null): string | null {
    if (key === null || key === DAEMON_KEY) return null;
    if (key.startsWith("repo:")) return key.slice("repo:".length);
    return this.#sessionRepos.get(key.slice("session:".length)) ?? null;
  }

  #putCenter(keep: Set<string>, model: HomeModel, layout: OrbitLayout): void {
    const { palette, motion } = this.#options;
    this.#put(keep, DAEMON_KEY, model.daemonRunning, ORIGIN, () => daemonCore(model.daemonRunning, palette, motion));
    this.#put(keep, "track", SESSION_RADIUS, ORIGIN, () => sessionTrack(SESSION_RADIUS, palette));
    for (const [i, sector] of layout.sectors.entries()) {
      this.#put(keep, `sector:${i}`, sector, ORIGIN, () => sectorArc(REPO_RADIUS + 0.7, sector.start, sector.span, palette));
    }
  }

  #putRepos(keep: Set<string>, model: HomeModel, layout: OrbitLayout): void {
    const { palette, motion } = this.#options;
    for (const repo of model.repos) {
      const at = layout.repos.get(repo.id);
      if (!at) continue;
      const kind = repoKind(repo.layer, model.layers.length);
      const place = { position: { x: at.x, y: 0, z: at.z }, angle: at.angle };
      this.#put(keep, repoKey(repo.id), { repo, kind }, place, () => repoModel(repo, kind, palette, motion), repoLabel(repo));
    }
  }

  #putSessions(keep: Set<string>, model: HomeModel, layout: OrbitLayout): void {
    const { palette, motion } = this.#options;
    this.#sessionRepos.clear();
    for (const session of model.sessions) {
      const at = layout.sessions.get(session.id);
      const repoAt = layout.repos.get(session.repo);
      if (!at || !repoAt) continue;
      this.#sessionRepos.set(session.id, session.repo);
      const place = { position: { x: at.x, y: SESSION_Y, z: at.z } };
      this.#put(keep, sessionKey(session.id), session, place, () => sessionPod(session, palette, motion), sessionLabel(session));
      // Przewód od drona do repo: kolor stanu sesji, żeby błąd było widać także przy repo.
      const color = sessionStateColor(session.state, palette);
      const curve = new QuadraticBezierCurve3(
        new Vector3(at.x, SESSION_Y, at.z),
        new Vector3((at.x + repoAt.x) / 2, SESSION_Y, (at.z + repoAt.z) / 2),
        new Vector3(repoAt.x, TETHER_END_Y, repoAt.z),
      );
      this.#put(keep, `tether:${session.id}`, { at, repoAt, color }, ORIGIN, () => linkTube(curve, "package", color, motion));
    }
  }

  #putLink(keep: Set<string>, link: HomeLink, layout: OrbitLayout): void {
    const from = layout.repos.get(link.from);
    const to = layout.repos.get(link.to);
    if (!from || !to) return;
    const key = `link:${link.from}>${link.to}:${link.kind}`;
    const curve = new QuadraticBezierCurve3(
      new Vector3(from.x, LINK_Y, from.z),
      new Vector3(((from.x + to.x) / 2) * LINK_PULL, LINK_Y, ((from.z + to.z) / 2) * LINK_PULL),
      new Vector3(to.x, LINK_Y, to.z),
    );
    this.#put(keep, key, { from, to, kind: link.kind }, ORIGIN, () => {
      const visual = linkTube(curve, link.kind, this.#options.palette.accent, this.#options.motion);
      this.#links.set(key, { link, visual });
      return visual;
    });
  }

  /**
   * Zapewnia encję obiektu i zostawia ją w `keep`. Model buduje od nowa tylko wtedy, gdy zmienił się `look`, czyli
   * wszystko, od czego zależy wygląd (stan, rodzaj, położenie).
   */
  #put(keep: Set<string>, key: string, look: unknown, place: Placement, build: () => HomeVisual, label: string | null = null): void {
    keep.add(key);
    const signature = JSON.stringify(look);
    const existing = this.#nodes.get(key);
    if (existing?.signature === signature) return;
    const visual = build();
    const entity = this.#entities.ensure(key, () => this.#spawn(key));
    if (!entity) throw new Error(`Nie udało się utworzyć encji ${key} na pulpicie`);
    if (existing) disposeObject3D(existing.visual.object);
    if (entity.has(Visual)) entity.set(Visual, visual.object);
    else entity.add(Visual(visual.object));
    entity.set(Position, place.position);
    if (place.angle !== undefined) entity.set(Rotation, euler({ y: -place.angle - Math.PI / 2 }));
    this.#setLabel(entity, key, label);
    this.#nodes.set(key, { signature, visual, offs: existing?.offs ?? this.#listen(entity, key) });
  }

  #spawn(key: string): Entity {
    const interactive = isHomeKey(key);
    const entity = this.#engine.spawn(Position, Rotation, Scale(uniform(1)));
    if (interactive) entity.add(Hoverable, Clickable);
    return entity;
  }

  #listen(entity: Entity, key: string): Array<() => void> {
    if (!isHomeKey(key)) return [];
    const { events } = this.#engine;
    const { onSelect, onOpen, onHover } = this.#options;
    return [
      events.on(entity, "click", () => onSelect?.(key)),
      events.on(entity, "doubleclick", () => onOpen?.(key)),
      events.on(entity, "pointerenter", () => onHover?.(key)),
      events.on(entity, "pointerleave", () => onHover?.(null)),
    ];
  }

  #setLabel(entity: Entity, key: string, text: string | null): void {
    if (entity.has(Label)) entity.remove(Label);
    const { createLabel } = this.#options;
    if (!text || !createLabel || !isHomeKey(key)) return;
    const offset = key.startsWith("session:") ? LABEL_OFFSET.session : LABEL_OFFSET.repo;
    entity.add(Label({ element: createLabel(text, key), offset: { y: offset } }));
  }

  #release(entity: Entity, key: string): void {
    const node = this.#nodes.get(key);
    this.#nodes.delete(key);
    this.#links.delete(key);
    for (const off of node?.offs ?? []) off();
    if (node) disposeObject3D(node.visual.object);
    entity.destroy();
  }
}

function isHomeKey(key: string): key is HomeKey {
  return key === DAEMON_KEY || key.startsWith("repo:") || key.startsWith("session:");
}
