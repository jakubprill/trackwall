import {
  Clickable,
  disposeObject3D,
  type Engine,
  euler,
  Hoverable,
  KeyedEntities,
  Label,
  Labels,
  Position,
  Rotation,
  Scale,
  uniform,
  Visual,
} from "@pawnjs/core";
import type { Entity } from "koota";
import { QuadraticBezierCurve3, Vector3 } from "three";
import { CALLOUT_RUN, type CalloutInput, type CalloutPlacement, type CalloutSide, layoutCallouts } from "./callout-layout.ts";
import { type RepoLabelTone, repoLabelTone, sessionHasLabel } from "./home-labels.ts";
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
import { coreLook, daemonCore } from "./models/daemon-core.ts";
import { floorGrid } from "./models/floor-grid.ts";
import type { HomeVisual } from "./models/kit.ts";
import { LINK_TUBES, type LinkEmphasis, type LinkVisual, linkTube, TETHER_TUBE } from "./models/link-tube.ts";
import { type RepoLook, repoLook, repoModel } from "./models/repo-model.ts";
import { repoOrb } from "./models/repo-orb.ts";
import { sectorArc } from "./models/sector-arc.ts";
import { sessionOrb } from "./models/session-orb.ts";
import { sessionPod } from "./models/session-pod.ts";
import { sessionTrack } from "./models/session-track.ts";
import { type OrbitLayout, orbitLayout, REPO_RADIUS, SESSION_RADIUS } from "./orbit-layout.ts";
import { assertScenePalette, type ScenePalette, sessionStateColor } from "./palette.ts";
import { repoKind } from "./repo-kind.ts";
import type { SceneLabelMode, SceneStyle } from "./scene-style.ts";

/**
 * Dashboard scene on the Pawn engine (ADR-33, §5.5). `apply` takes successive dashboard snapshots and keeps one entity
 * per object (`KeyedEntities`): a new object gets an entity, a vanished one loses it, each one moves to where it falls in
 * the new layout, and a model is rebuilt only when something visible has changed. The caller provides the engine, camera,
 * pointer and labels, so the same scene works in a window and in a test without a browser.
 */

/**
 * An object that gets a label; the UI writes its text. A `quiet` repo label (a clean repo with nothing running) carries only
 * the name, a `full` one also what is going on.
 */
export type LabelTarget =
  | { kind: "repo"; key: HomeKey; repo: HomeRepo; tone: RepoLabelTone }
  | { kind: "session"; key: HomeKey; session: HomeSession };

export interface HomeSceneOptions {
  /** Colours as `#rrggbb` (`ScenePalette`); any other notation is an error when the scene is created. */
  palette: ScenePalette;
  /** How repos and sessions are drawn (ADR-104). Changing it needs a new scene. */
  style: SceneStyle;
  /** Which objects have a label (ADR-104). Changing it needs a new scene. */
  labels: SceneLabelMode;
  /**
   * `false` under `prefers-reduced-motion`: models hold their pose from time 0, and only colour and shape show state.
   * Changing the setting while running needs a new scene.
   */
  motion: boolean;
  /**
   * Click: the scene itself highlights the object and its connections (`focus`), and the UI shows the details. `null` when
   * the selected object has vanished from the snapshot.
   */
  onSelect?: (key: HomeKey | null) => void;
  /** Double click: go to the session or repo. */
  onOpen?: (key: HomeKey) => void;
  /** The pointer entered an object or left it (`null`), also when the hovered object vanished from the snapshot. */
  onHover?: (key: HomeKey | null) => void;
  /**
   * Label element; without this function the scene adds no labels. The label is a callout beside its object (ADR-104): the
   * scene sets `data-side` (`left` or `right` of the object) and the CSS variables `--callout-run` (horizontal run of the
   * leader line) and `--callout-rise` (how far the label's middle stands above the object), both in pixels, and the UI draws
   * the leader line from them.
   */
  createLabel?: (target: LabelTarget) => HTMLElement;
}

/** Height of a session drone above the floor. */
const SESSION_Y = 0.55;
/** Height at which a session wire reaches the repo. */
const TETHER_END_Y = 0.4;
/** Height of connection wires. */
const LINK_Y = 0.12;
/**
 * The control point of a connection curve is the chord midpoint times this value: 1 is a straight chord, less pulls the
 * curve towards the centre of the ring, and 0 the most (the curve's midpoint falls halfway from the chord to the centre).
 */
const LINK_BEND = 0.2;
const FOCUS_SCALE = 1.12;
const LABEL_OFFSET: Record<LabelTarget["kind"], number> = { repo: 1.05, session: 0.5 };
/** The radius of the floor grid: a little past the layer arcs. */
const FLOOR_RADIUS = REPO_RADIUS + 2.6;

type RepoBuilder = (look: RepoLook, palette: ScenePalette) => HomeVisual;
type SessionBuilder = (session: HomeSession, palette: ScenePalette) => HomeVisual;
const STYLE_MODELS: Record<SceneStyle, { repo: RepoBuilder; session: SessionBuilder }> = {
  holo: { repo: repoModel, session: sessionPod },
  orbs: { repo: repoOrb, session: sessionOrb },
};

/** A label on the scene with where its callout stood in the last frame; the size is measured once, when it is first shown. */
interface Callout {
  label: { element: HTMLElement; offset: { y: number } };
  side: CalloutSide | null;
  rise: number | null;
  size: { width: number; height: number } | null;
}

interface Node {
  signature: string;
  visual: HomeVisual;
  labelSignature: string | null;
  offs: Array<() => void>;
}

interface Placement {
  position: { x: number; y: number; z: number };
  /** Angle on the ring: the model turns its front to the centre. */
  angle?: number;
}

const ORIGIN: Placement = { position: { x: 0, y: 0, z: 0 } };
const CENTRE = new Vector3(0, 0, 0);

/** The element's edge that touches the leader line, at its middle: `Labels` puts that point on the object. */
function calloutAlign(side: CalloutSide): { x: number; y: number } {
  return { x: side === "right" ? 0 : 1, y: 0.5 };
}

export class HomeScene {
  readonly #engine: Engine;
  readonly #options: HomeSceneOptions;
  readonly #entities: KeyedEntities<string>;
  readonly #nodes = new Map<string, Node>();
  /** Connection wires from the graph, by entity key, for highlighting on selection. */
  readonly #links = new Map<string, { link: HomeLink; visual: LinkVisual }>();
  /** The repo of each session from the last snapshot: selecting a session highlights its repo's connections. */
  readonly #sessionRepos = new Map<string, string>();
  /** The last place of each entity. */
  readonly #places = new Map<string, string>();
  readonly #callouts = new Map<HomeKey, Callout>();
  /** A reused point for projecting callout anchors, so laying them out allocates nothing per frame but the screen points. */
  readonly #anchor = new Vector3();
  readonly #removeSystems: Array<() => void> = [];
  #focus: HomeKey | null = null;
  #hovered: HomeKey | null = null;

  constructor(engine: Engine, options: HomeSceneOptions) {
    assertScenePalette(options.palette);
    this.#engine = engine;
    this.#options = options;
    this.#entities = new KeyedEntities<string>(engine, { release: (entity, key) => this.#release(entity, key) });
    if (options.motion) {
      this.#removeSystems.push(
        engine.addSystem(({ elapsed }) => {
          for (const node of this.#nodes.values()) node.visual.animate?.(elapsed);
        }),
      );
    }
    // Before `Labels`, which then puts each element where its side says.
    if (options.createLabel)
      this.#removeSystems.push(engine.addSystem(() => this.#placeCallouts(), { phase: "render", order: Labels.ORDER - 1 }));
  }

  /** The object's entity, for example to point the camera at it (`CameraRig.focus`). */
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
    const lost = this.#focus !== null && !this.#nodes.has(this.#focus);
    this.focus(lost ? null : this.#focus);
    if (lost) this.#options.onSelect?.(null);
  }

  /** Highlights an object and its connections; `null` returns to the full view. */
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
    for (const remove of this.#removeSystems) remove();
    this.#callouts.clear();
    // A scene being disposed no longer reports hover or selection, so the UI gets no calls while unmounting.
    this.#hovered = null;
    this.#focus = null;
    // Resources are freed directly, not through `release`, because `KeyedEntities.clear()` skips it after the engine is disposed.
    for (const node of this.#nodes.values()) {
      for (const off of node.offs) off();
      disposeObject3D(node.visual.object);
    }
    this.#nodes.clear();
    this.#links.clear();
    this.#places.clear();
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
    const core = coreLook(model.daemonRunning, model.sessions);
    this.#put(keep, DAEMON_KEY, core, ORIGIN, () => daemonCore(core, palette));
    this.#put(keep, "floor", FLOOR_RADIUS, ORIGIN, () => floorGrid(FLOOR_RADIUS, palette));
    this.#put(keep, "track", SESSION_RADIUS, ORIGIN, () => sessionTrack(SESSION_RADIUS, palette));
    for (const [i, sector] of layout.sectors.entries()) {
      this.#put(keep, `sector:${i}`, sector, ORIGIN, () => sectorArc(REPO_RADIUS + 0.7, sector.start, sector.span, palette));
    }
  }

  #putRepos(keep: Set<string>, model: HomeModel, layout: OrbitLayout): void {
    for (const repo of model.repos) {
      const at = layout.repos.get(repo.id);
      if (!at) throw new Error(`Repo ${repo.id} has no place in the dashboard layout`);
      const key = repoKey(repo.id);
      const look = repoLook(repo, repoKind(repo.layer, model.layerCount));
      const place = { position: { x: at.x, y: 0, z: at.z }, angle: at.angle };
      this.#put(keep, key, look, place, () => STYLE_MODELS[this.#options.style].repo(look, this.#options.palette));
      const tone = repoLabelTone(repo, this.#options.labels);
      this.#setLabel(key, tone ? { kind: "repo", key, repo, tone } : null);
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
      this.#put(keep, key, session, { position: { x: at.x, y: SESSION_Y, z: at.z } }, () =>
        STYLE_MODELS[this.#options.style].session(session, palette),
      );
      this.#setLabel(key, sessionHasLabel(session) ? { kind: "session", key, session } : null);
      // Wire from the drone to the repo in the session state colour, so an error is visible at the repo too.
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
    // JSON, because a repo identifier can contain any character, the separator included.
    const key = `link:${JSON.stringify([link.from, link.to, link.kind])}`;
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
   * Makes sure the object has an entity, keeps it in `keep` and puts it at `place`. Rebuilds the model only when `look` has
   * changed, that is everything the appearance depends on; moving alone does not rebuild the model.
   */
  #put(keep: Set<string>, key: string, look: unknown, place: Placement, build: () => HomeVisual): void {
    keep.add(key);
    const entity = this.#entities.ensure(key, () => this.#spawn(key));
    if (!entity) throw new Error(`Could not create entity ${key} on the dashboard`);
    this.#place(key, entity, place);
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

  /** Moves an entity only when its place has changed, so an unchanged snapshot does not move entities. */
  #place(key: string, entity: Entity, place: Placement): void {
    const signature = JSON.stringify(place);
    if (this.#places.get(key) === signature) return;
    this.#places.set(key, signature);
    entity.set(Position, place.position);
    if (place.angle !== undefined) entity.set(Rotation, euler({ y: -place.angle - Math.PI / 2 }));
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

  /** A label changes only when what the UI writes in it has changed. */
  #setLabel(key: HomeKey, target: LabelTarget | null): void {
    const node = this.#nodes.get(key);
    const entity = this.#entities.get(key);
    const { createLabel } = this.#options;
    if (!node || !entity || !createLabel) return;
    const signature = target === null ? null : JSON.stringify(target);
    if (node.labelSignature === signature) return;
    node.labelSignature = signature;
    if (entity.has(Label)) entity.remove(Label);
    this.#callouts.delete(key);
    if (!target) return;
    const label = { element: createLabel(target), offset: { y: LABEL_OFFSET[target.kind] } };
    label.element.style.setProperty("--callout-run", `${CALLOUT_RUN}px`);
    entity.add(Label({ ...label, align: calloutAlign("right") }));
    this.#callouts.set(key, { label, side: null, rise: null, size: null });
  }

  /**
   * Puts every visible callout beside its object, away from the middle of the ring, and lifts callouts that would cover each
   * other (`layoutCallouts`). Writes to an element only what changed, because most frames move nothing.
   */
  #placeCallouts(): void {
    const { views } = this.#engine;
    const canvas = this.#callouts.size > 0 ? views.canvasRect() : null;
    const centre = canvas && views.project(CENTRE);
    if (!canvas || !centre) return;
    const bounds = { left: canvas.left, right: canvas.left + canvas.width };
    for (const [key, placement] of layoutCallouts(this.#calloutInputs(), centre.x, bounds)) this.#moveCallout(key, placement);
  }

  /** Callouts whose object is on the screen, with their measured size; one not laid out by the browser yet waits. */
  #calloutInputs(): CalloutInput<HomeKey>[] {
    const inputs: CalloutInput<HomeKey>[] = [];
    for (const [key, callout] of this.#callouts) {
      const position = this.#entities.get(key)?.get(Position);
      const anchor = position && this.#engine.views.project(this.#anchor.set(position.x, position.y + callout.label.offset.y, position.z));
      if (!anchor?.visible) continue;
      const { element } = callout.label;
      callout.size ??= element.offsetWidth > 0 ? { width: element.offsetWidth, height: element.offsetHeight } : null;
      if (callout.size) inputs.push({ key, anchor, ...callout.size, side: callout.side });
    }
    return inputs;
  }

  #moveCallout(key: HomeKey, placement: CalloutPlacement): void {
    const callout = this.#callouts.get(key);
    const entity = this.#entities.get(key);
    if (!callout || !entity) return;
    if (callout.side !== placement.side) {
      callout.side = placement.side;
      callout.label.element.dataset.side = placement.side;
      entity.set(Label, { ...callout.label, align: calloutAlign(placement.side) });
    }
    const rise = Math.round(placement.rise);
    if (callout.rise !== rise) {
      callout.rise = rise;
      callout.label.element.style.setProperty("--callout-rise", `${rise}px`);
    }
  }

  #release(entity: Entity, key: string): void {
    const node = this.#nodes.get(key);
    this.#nodes.delete(key);
    this.#links.delete(key);
    this.#places.delete(key);
    if (isHomeKey(key)) this.#callouts.delete(key);
    for (const off of node?.offs ?? []) off();
    if (node) disposeObject3D(node.visual.object);
    if (key === this.#hovered) this.#hover(null);
    entity.destroy();
  }
}
