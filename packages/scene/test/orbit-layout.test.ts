import { describe, expect, test } from "bun:test";
import type { HomeRepo } from "../src/home-model.ts";
import { orbitLayout, REPO_RADIUS, SESSION_RADIUS } from "../src/orbit-layout.ts";

const repo = (id: string, layer: number | null): HomeRepo => ({ id, layer, state: "clean", count: 0, runningTask: null });

describe("Orbit layout", () => {
  test("repos lie on the outer ring, and the first layer is at the back of the scene", () => {
    const layout = orbitLayout({ layerCount: 2, repos: [repo("web", 0), repo("lib", 1)], sessions: [] });

    for (const at of layout.repos.values()) expect(Math.hypot(at.x, at.z)).toBeCloseTo(REPO_RADIUS);
    expect(layout.repos.get("web")?.angle).toBeCloseTo(-Math.PI / 2);
    expect(layout.sectors).toHaveLength(2);
  });

  test("a layer's arc is proportional to the number of its repos", () => {
    const layout = orbitLayout({ layerCount: 2, repos: [repo("bff", 0), repo("a", 1), repo("b", 1), repo("c", 1)], sessions: [] });

    const [bff, services] = layout.sectors;
    expect((services?.span ?? 0) / (bff?.span ?? 1)).toBeCloseTo(3);
  });

  test("an empty layer gets no arc", () => {
    const layout = orbitLayout({ layerCount: 3, repos: [repo("web", 0), repo("lib", 2)], sessions: [] });

    expect(layout.sectors).toHaveLength(2);
  });

  test("repos without connections in the graph get the last arc, also when there is no graph yet", () => {
    const withGraph = orbitLayout({ layerCount: 1, repos: [repo("docs", null), repo("orders", 0)], sessions: [] });
    const withoutGraph = orbitLayout({ layerCount: 0, repos: [repo("docs", null), repo("tools", null)], sessions: [] });

    expect(withGraph.sectors).toHaveLength(2);
    expect(withGraph.repos.get("orders")?.angle).toBeCloseTo(-Math.PI / 2);
    expect(withoutGraph.repos.size).toBe(2);
  });

  test("sessions stand on the track opposite their repo, several sessions of one repo side by side", () => {
    const layout = orbitLayout({
      layerCount: 1,
      repos: [repo("orders", 0), repo("users", 0)],
      sessions: [
        { id: "s1", repo: "orders", state: "working" },
        { id: "s2", repo: "orders", state: "attention" },
        { id: "s3", repo: "users", state: "done" },
      ],
    });

    const orders = layout.repos.get("orders")?.angle ?? Number.NaN;
    const [s1, s2, s3] = ["s1", "s2", "s3"].map((id) => layout.sessions.get(id));
    expect(Math.hypot(s1?.x ?? 0, s1?.z ?? 0)).toBeCloseTo(SESSION_RADIUS);
    expect(((s1?.angle ?? 0) + (s2?.angle ?? 0)) / 2).toBeCloseTo(orders);
    expect(s1?.angle).not.toBeCloseTo(s2?.angle ?? 0);
    expect(s3?.angle).toBeCloseTo(layout.repos.get("users")?.angle ?? Number.NaN);
  });

  test("with many sessions in neighbouring repos, sessions stay by their repo, in repo order", () => {
    const repos = Array.from({ length: 15 }, (_, i) => repo(`r${i}`, 0));
    const sessions = repos.flatMap((r) => [1, 2, 3, 4].map((n) => ({ id: `${r.id}-${n}`, repo: r.id, state: "working" as const })));
    const layout = orbitLayout({ layerCount: 1, repos, sessions });

    const angles = sessions.map((s) => layout.sessions.get(s.id)?.angle ?? Number.NaN);
    const gaps = angles.slice(1).map((angle, i) => angle - (angles[i] ?? Number.NaN));
    expect(Math.min(...gaps)).toBeGreaterThan(0.02);
  });

  test("a session of a repo outside the model has no place on the track", () => {
    const layout = orbitLayout({ layerCount: 1, repos: [repo("orders", 0)], sessions: [{ id: "s1", repo: "removed", state: "working" }] });

    expect(layout.sessions.has("s1")).toBe(false);
  });

  test("a repo with a layer outside the number of layers is an error naming the repo", () => {
    expect(() => orbitLayout({ layerCount: 1, repos: [repo("orders", 1)], sessions: [] })).toThrow("orders");
  });
});
