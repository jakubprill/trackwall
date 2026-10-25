import { afterEach, describe, expect, test } from "bun:test";
import { Label, Position, Scale, Visual } from "@pawnjs/core";
import { createTestEngine, runFor } from "@pawnjs/core/testing";
import { type Intersection, Mesh, type MeshBasicMaterial, Raycaster, TubeGeometry, Vector3 } from "three";
import { type HomeKey, type HomeModel, HomeScene, type ScenePalette } from "../src/index.ts";
import { TUBE_NAMES } from "../src/models/link-tube.ts";

const PALETTE: ScenePalette = {
  primary: "#3fd2e8",
  warning: "#f0b44c",
  destructive: "#ef6a6a",
  muted: "#8399a5",
  idle: "#35505d",
  body: "#101d24",
  plate: "#0a151b",
};

const MODEL: HomeModel = {
  layerCount: 3,
  repos: [
    { id: "web-shop", layer: 0, state: "behind", count: 1, runningTask: null },
    { id: "orders-api", layer: 1, state: "clean", count: 0, runningTask: "dev" },
    { id: "payments-api", layer: 1, state: "changed", count: 3, runningTask: null },
    { id: "common-dto", layer: 2, state: "clean", count: 0, runningTask: null },
  ],
  sessions: [
    { id: "s1", repo: "orders-api", state: "attention" },
    { id: "s2", repo: "payments-api", state: "working" },
  ],
  links: [
    { from: "web-shop", to: "orders-api", kind: "http" },
    { from: "orders-api", to: "common-dto", kind: "package" },
    { from: "payments-api", to: "common-dto", kind: "package" },
  ],
  daemonRunning: true,
};

let engine = createTestEngine();
afterEach(() => {
  engine.dispose();
  engine = createTestEngine();
});

/**
 * Position, rotation and opacity of every part of the model: they change only when the model moves. The entity's
 * object is left out, because the engine copies its position from `Position`.
 */
function pose(key: HomeKey, scene: HomeScene): string {
  const parts: number[] = [];
  for (const child of scene.entity(key)?.get(Visual)?.children ?? []) {
    child.traverse((o) => {
      parts.push(...o.position.toArray(), o.rotation.x, o.rotation.y, o.rotation.z);
      if (o instanceof Mesh) parts.push((o.material as MeshBasicMaterial).opacity);
    });
  }
  return parts.map((n) => n.toFixed(4)).join(",");
}

/** Opacity of the connection wires from the graph; session wires have a different name and no highlighting. */
function linkOpacities(): number[] {
  const found: number[] = [];
  engine.scene.traverse((o) => {
    if (o instanceof Mesh && o.name === TUBE_NAMES.link) found.push((o.material as MeshBasicMaterial).opacity);
  });
  return found.sort();
}

const positionOf = (key: HomeKey, scene: HomeScene) => scene.entity(key)?.get(Position);

describe("dashboard scene", () => {
  test("every repo, session and the daemon get an entity with a model to draw", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);

    const keys: HomeKey[] = [
      "daemon",
      "repo:web-shop",
      "repo:orders-api",
      "repo:payments-api",
      "repo:common-dto",
      "session:s1",
      "session:s2",
    ];
    for (const key of keys) expect(scene.entity(key)?.get(Visual)).toBeDefined();
    expect(linkOpacities()).toHaveLength(3);
  });

  test("the same snapshot a second time does not rebuild the models", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);
    const before = scene.entity("repo:orders-api")?.get(Visual);

    scene.apply(structuredClone(MODEL));

    expect(scene.entity("repo:orders-api")?.get(Visual)).toBe(before);
  });

  test("a change of repo state replaces only its model", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);
    const orders = scene.entity("repo:orders-api")?.get(Visual);
    const web = scene.entity("repo:web-shop")?.get(Visual);

    scene.apply({ ...MODEL, repos: MODEL.repos.map((r) => (r.id === "orders-api" ? { ...r, state: "changed", count: 2 } : r)) });

    expect(scene.entity("repo:orders-api")?.get(Visual)).not.toBe(orders);
    expect(scene.entity("repo:web-shop")?.get(Visual)).toBe(web);
  });

  test("a repo that vanished from the snapshot loses its entity together with its session and connections", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);

    scene.apply({ ...MODEL, repos: MODEL.repos.filter((r) => r.id !== "payments-api") });

    expect(scene.entity("repo:payments-api")).toBeUndefined();
    expect(scene.entity("session:s2")).toBeUndefined();
    expect(linkOpacities()).toHaveLength(2);
  });

  test("a click selects an object and a double click opens it", () => {
    const selected: Array<HomeKey | null> = [];
    const opened: HomeKey[] = [];
    const scene = new HomeScene(engine, {
      palette: PALETTE,
      motion: true,
      onSelect: (k) => selected.push(k),
      onOpen: (k) => opened.push(k),
    });
    scene.apply(MODEL);
    const session = scene.entity("session:s1");
    if (!session) throw new Error("no entity for session s1");

    engine.events.emit(session, "click", { button: 0, point: undefined });
    engine.events.emit(session, "doubleclick", { button: 0, point: undefined });

    expect(selected).toEqual(["session:s1"]);
    expect(opened).toEqual(["session:s1"]);
    expect(scene.entity("session:s1")?.get(Scale)?.x).toBeCloseTo(1.12);
  });

  test("adding a repo moves the other repos and their sessions to new places in the layout", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply({ ...MODEL, repos: MODEL.repos.filter((r) => r.id !== "payments-api") });
    const at = positionOf("repo:orders-api", scene);
    const before = { x: at?.x, z: at?.z };
    const model = scene.entity("repo:orders-api")?.get(Visual);

    scene.apply(MODEL);

    const after = positionOf("repo:orders-api", scene);
    expect({ x: after?.x, z: after?.z }).not.toEqual(before);
    expect(scene.entity("repo:orders-api")?.get(Visual)).toBe(model);
    expect(Math.atan2(positionOf("session:s1", scene)?.z ?? 0, positionOf("session:s1", scene)?.x ?? 0)).toBeCloseTo(
      Math.atan2(positionOf("repo:orders-api", scene)?.z ?? 0, positionOf("repo:orders-api", scene)?.x ?? 0),
    );
  });

  test("a change in the number of changes beyond the number of bars does not rebuild the repo model", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    const withCount = (count: number): HomeModel => ({
      ...MODEL,
      repos: MODEL.repos.map((r) => (r.id === "payments-api" ? { ...r, count } : r)),
    });
    scene.apply(withCount(7));
    const before = scene.entity("repo:payments-api")?.get(Visual);

    scene.apply(withCount(9));

    expect(scene.entity("repo:payments-api")?.get(Visual)).toBe(before);
  });

  test("a hovered object that vanished from the snapshot ends the hover", () => {
    const hovered: Array<HomeKey | null> = [];
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true, onHover: (k) => hovered.push(k) });
    scene.apply(MODEL);
    const session = scene.entity("session:s2");
    if (!session) throw new Error("no entity for session s2");

    engine.events.emit(session, "pointerenter", {});
    scene.apply({ ...MODEL, sessions: MODEL.sessions.filter((s) => s.id !== "s2") });

    expect(hovered).toEqual(["session:s2", null]);
  });

  test("a selected object that vanished from the snapshot ends the selection", () => {
    const selected: Array<HomeKey | null> = [];
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true, onSelect: (k) => selected.push(k) });
    scene.apply(MODEL);
    const session = scene.entity("session:s2");
    if (!session) throw new Error("no entity for session s2");

    engine.events.emit(session, "click", { button: 0, point: undefined });
    scene.apply({ ...MODEL, sessions: MODEL.sessions.filter((s) => s.id !== "s2") });

    expect(selected).toEqual(["session:s2", null]);
    expect(linkOpacities()).toEqual([0.22, 0.22, 0.22]);
  });

  test("wires do not hide repos or sessions from the pointer", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: false });
    scene.apply(MODEL);
    const hits: Intersection[] = [];
    engine.scene.traverse((o) => {
      if (!(o instanceof Mesh && o.geometry instanceof TubeGeometry)) return;
      // A ray from above straight into the middle of the wire.
      const middle = o.geometry.parameters.path.getPoint(0.5);
      const ray = new Raycaster(new Vector3(middle.x, 5, middle.z), new Vector3(0, -1, 0));
      o.raycast(ray, hits);
    });

    expect(hits).toEqual([]);
  });

  test("a disposed scene reports no end of hover or selection", () => {
    const calls: Array<HomeKey | null> = [];
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true, onHover: (k) => calls.push(k), onSelect: (k) => calls.push(k) });
    scene.apply(MODEL);
    const session = scene.entity("session:s1");
    if (!session) throw new Error("no entity for session s1");
    engine.events.emit(session, "pointerenter", {});
    engine.events.emit(session, "click", { button: 0, point: undefined });

    scene.dispose();

    expect(calls).toEqual(["session:s1", "session:s1"]);
  });

  test("connections of repos whose names contain separators do not merge into one", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    const repo = (id: string, layer: number) => ({ id, layer, state: "clean" as const, count: 0, runningTask: null });

    scene.apply({
      layerCount: 2,
      repos: [repo("a>b", 0), repo("a", 0), repo("c", 1), repo("b>c", 1)],
      sessions: [],
      links: [
        { from: "a>b", to: "c", kind: "http" },
        { from: "a", to: "b>c", kind: "http" },
      ],
      daemonRunning: true,
    });

    expect(linkOpacities()).toHaveLength(2);
  });

  test("a colour not written as #rrggbb, for example an oklch token straight from CSS, is an error when the scene is created", () => {
    expect(() => new HomeScene(engine, { palette: { ...PALETTE, primary: "oklch(0.82 0.12 210)" }, motion: true })).toThrow("primary");
  });

  test("selecting a session enlarges it and brightens its repo's connections, and dims the rest", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);

    scene.focus("session:s1");

    expect(scene.entity("session:s1")?.get(Scale)?.x).toBeCloseTo(1.12);
    expect(linkOpacities()).toEqual([0.05, 0.85, 0.85]);
    scene.focus(null);
    expect(linkOpacities()).toEqual([0.22, 0.22, 0.22]);
  });

  test("only repos that are not clean and sessions that are waiting or have an error get labels", () => {
    const labelled: string[] = [];
    const scene = new HomeScene(engine, {
      palette: PALETTE,
      motion: true,
      createLabel: (target) => {
        labelled.push(target.key);
        return { style: {} } as unknown as HTMLElement;
      },
    });

    scene.apply(MODEL);
    scene.apply(structuredClone(MODEL));

    expect(labelled.sort()).toEqual(["repo:payments-api", "repo:web-shop", "session:s1"]);
    expect(scene.entity("repo:orders-api")?.has(Label)).toBe(false);
  });

  test("disposing the scene frees model geometries also after the engine is disposed", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);
    let geometries = 0;
    let disposed = 0;
    engine.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      geometries++;
      o.geometry.addEventListener("dispose", () => disposed++);
    });

    engine.dispose();
    scene.dispose();

    expect(disposed).toBe(geometries);
  });

  test("without motion the scene stands still: frames do not change the models", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: false });
    scene.apply(MODEL);
    const before = pose("session:s1", scene);

    runFor(engine, 1);

    expect(pose("session:s1", scene)).toBe(before);
  });

  test("with motion a waiting session moves", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);
    const before = pose("session:s1", scene);

    runFor(engine, 0.5);

    expect(pose("session:s1", scene)).not.toBe(before);
  });
});
