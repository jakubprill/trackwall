import { expect, test } from "bun:test";
import type { Vector3 } from "three";
import { type CalloutLabel, calloutAlign, SceneCallouts } from "../src/scene-callouts.ts";

/** A label element for a test without a browser: its size, its `data-side` and the CSS variables the callouts set. */
function element(width: number, height: number) {
  const properties = new Map<string, string>();
  const fake = {
    offsetWidth: width,
    offsetHeight: height,
    dataset: {} as DOMStringMap,
    style: { setProperty: (n: string, v: string) => properties.set(n, v) },
  };
  return { element: fake as unknown as HTMLElement, properties };
}

/** A camera looking straight down: world x and z are screen x and y, and the middle of the ring is at (500, 300). */
const views = {
  canvasRect: () => ({ left: 0, width: 1000 }),
  project: (p: Vector3) => ({ x: 500 + p.x * 50, y: 300 + p.z * 50, visible: true }),
};

function callouts(positions: Record<string, { x: number; y: number; z: number }>) {
  const shown: Array<{ key: string; align: { x: number; y: number } }> = [];
  const scene = new SceneCallouts<string>(views, {
    position: (key) => positions[key],
    showLabel: (key, label) => shown.push({ key, align: label.align }),
  });
  return { scene, shown };
}

test("a new callout starts on the right with the base rise and tells the UI the leader line's run", () => {
  const { scene, shown } = callouts({});
  const label = element(100, 30);

  scene.attach("repo:a", { element: label.element, offset: { y: 1 } });

  expect(shown).toEqual([{ key: "repo:a", align: { x: 0, y: 0.5 } }]);
  expect(label.element.dataset.side).toBe("right");
  expect(Object.fromEntries(label.properties)).toEqual({ "--callout-run": "28px", "--callout-rise": "22px" });
});

test("a callout of an object left of the middle moves to the left side and is aligned by its right edge", () => {
  const { scene, shown } = callouts({ "repo:a": { x: -5, y: 0, z: 0 } });
  const label = element(100, 30);
  scene.attach("repo:a", { element: label.element, offset: { y: 1 } } satisfies CalloutLabel);

  scene.place();

  expect(label.element.dataset.side).toBe("left");
  expect(shown.at(-1)).toEqual({ key: "repo:a", align: calloutAlign("left") });
  expect(calloutAlign("left")).toEqual({ x: 1, y: 0.5 });
});

test("a callout that would cover a nearer one is lifted, and only the changed rise is written", () => {
  const { scene } = callouts({ "repo:front": { x: 2, y: 0, z: 1 }, "repo:behind": { x: 2.1, y: 0, z: 0.8 } });
  const front = element(100, 30);
  const behind = element(100, 30);
  scene.attach("repo:front", { element: front.element, offset: { y: 0 } });
  scene.attach("repo:behind", { element: behind.element, offset: { y: 0 } });

  scene.place();

  expect(front.properties.get("--callout-rise")).toBe("22px");
  expect(Number.parseInt(behind.properties.get("--callout-rise") ?? "", 10)).toBeGreaterThan(22);
});

test("a detached callout is no longer placed", () => {
  const { scene, shown } = callouts({ "repo:a": { x: -5, y: 0, z: 0 } });
  scene.attach("repo:a", { element: element(100, 30).element, offset: { y: 1 } });
  scene.detach("repo:a");

  scene.place();

  expect(shown).toHaveLength(1);
});
