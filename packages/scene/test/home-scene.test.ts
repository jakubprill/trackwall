import { afterEach, describe, expect, test } from "bun:test";
import { Label, Scale, Visual } from "@pawnjs/core";
import { createTestEngine, runFor } from "@pawnjs/core/testing";
import { Mesh, type MeshBasicMaterial, TubeGeometry } from "three";
import { type HomeKey, type HomeModel, HomeScene, type ScenePalette } from "../src/index.ts";

const PALETTE: ScenePalette = {
  accent: "#3fd2e8",
  warning: "#f0b44c",
  destructive: "#ef6a6a",
  muted: "#8399a5",
  idle: "#35505d",
  body: "#101d24",
  plate: "#0a151b",
};

const MODEL: HomeModel = {
  layers: ["Frontends", "Services", "Libraries"],
  repos: [
    { id: "web-shop", layer: 0, state: "behind", count: 1, hasMise: true, runningTask: null },
    { id: "orders-api", layer: 1, state: "clean", count: 0, hasMise: true, runningTask: "dev" },
    { id: "payments-api", layer: 1, state: "changed", count: 3, hasMise: false, runningTask: null },
    { id: "common-dto", layer: 2, state: "clean", count: 0, hasMise: true, runningTask: null },
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
 * Położenie, obrót i przezroczystość każdej części modelu: zmieniają się tylko wtedy, gdy model się rusza. Obiekt
 * encji jest pominięty, bo jego położenie silnik przepisuje z `Position`.
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

/** Przezroczystość przewodów połączeń z grafu (grubszych niż przewody sesji, które nie mają podświetlenia). */
function linkOpacities(): number[] {
  const found: number[] = [];
  engine.scene.traverse((o) => {
    if (o instanceof Mesh && o.geometry instanceof TubeGeometry && o.geometry.parameters.path.getLength() > 5)
      found.push((o.material as MeshBasicMaterial).opacity);
  });
  return found.sort();
}

describe("scena pulpitu", () => {
  test("każde repo, sesja i daemon dostają encję z modelem do narysowania", () => {
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

  test("ta sama migawka drugi raz nie buduje modeli od nowa", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);
    const before = scene.entity("repo:orders-api")?.get(Visual);

    scene.apply(structuredClone(MODEL));

    expect(scene.entity("repo:orders-api")?.get(Visual)).toBe(before);
  });

  test("zmiana stanu repo podmienia tylko jego model", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);
    const orders = scene.entity("repo:orders-api")?.get(Visual);
    const web = scene.entity("repo:web-shop")?.get(Visual);

    scene.apply({ ...MODEL, repos: MODEL.repos.map((r) => (r.id === "orders-api" ? { ...r, state: "changed", count: 2 } : r)) });

    expect(scene.entity("repo:orders-api")?.get(Visual)).not.toBe(orders);
    expect(scene.entity("repo:web-shop")?.get(Visual)).toBe(web);
  });

  test("repo, które zniknęło z migawki, traci encję razem ze swoją sesją i połączeniami", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);

    scene.apply({ ...MODEL, repos: MODEL.repos.filter((r) => r.id !== "payments-api") });

    expect(scene.entity("repo:payments-api")).toBeUndefined();
    expect(scene.entity("session:s2")).toBeUndefined();
    expect(linkOpacities()).toHaveLength(2);
  });

  test("kliknięcie wybiera obiekt, a dwuklik go otwiera", () => {
    const selected: HomeKey[] = [];
    const opened: HomeKey[] = [];
    const scene = new HomeScene(engine, {
      palette: PALETTE,
      motion: true,
      onSelect: (k) => selected.push(k),
      onOpen: (k) => opened.push(k),
    });
    scene.apply(MODEL);
    const session = scene.entity("session:s1");
    if (!session) throw new Error("brak encji sesji s1");

    engine.events.emit(session, "click", { button: 0, point: undefined });
    engine.events.emit(session, "doubleclick", { button: 0, point: undefined });

    expect(selected).toEqual(["session:s1"]);
    expect(opened).toEqual(["session:s1"]);
  });

  test("wybór sesji powiększa ją i rozjaśnia połączenia jej repo, a resztę przygasza", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);

    scene.focus("session:s1");

    expect(scene.entity("session:s1")?.get(Scale)?.x).toBeCloseTo(1.12);
    expect(linkOpacities()).toEqual([0.05, 0.85, 0.85]);
    scene.focus(null);
    expect(linkOpacities()).toEqual([0.22, 0.22, 0.22]);
  });

  test("etykiety dostają tylko repo, które nie są czyste, i sesje, które czekają albo mają błąd", () => {
    const labelled: string[] = [];
    const scene = new HomeScene(engine, {
      palette: PALETTE,
      motion: true,
      createLabel: (text, key) => {
        labelled.push(`${key} ${text}`);
        return { style: {} } as unknown as HTMLElement;
      },
    });

    scene.apply(MODEL);

    expect(labelled.sort()).toEqual(["repo:payments-api payments-api", "repo:web-shop web-shop", "session:s1 Needs you"]);
    expect(scene.entity("repo:orders-api")?.has(Label)).toBe(false);
  });

  test("bez ruchu scena stoi: klatki nie zmieniają modeli", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: false });
    scene.apply(MODEL);
    const before = pose("session:s1", scene);

    runFor(engine, 1);

    expect(pose("session:s1", scene)).toBe(before);
  });

  test("z ruchem czekająca sesja się porusza", () => {
    const scene = new HomeScene(engine, { palette: PALETTE, motion: true });
    scene.apply(MODEL);
    const before = pose("session:s1", scene);

    runFor(engine, 0.5);

    expect(pose("session:s1", scene)).not.toBe(before);
  });
});
