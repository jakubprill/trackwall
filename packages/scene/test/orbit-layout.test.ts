import { describe, expect, test } from "bun:test";
import { orbitLayout, REPO_RADIUS, SESSION_RADIUS } from "../src/orbit-layout.ts";

const repo = (id: string, layer: number) => ({ id, layer, state: "clean" as const, count: 0, hasMise: true, runningTask: null });

describe("układ Orbit", () => {
  test("repo leżą na zewnętrznym pierścieniu, a pierwsza warstwa jest z tyłu sceny", () => {
    const layout = orbitLayout({ layers: ["Frontends", "Libraries"], repos: [repo("web", 0), repo("lib", 1)], sessions: [] });

    for (const at of layout.repos.values()) expect(Math.hypot(at.x, at.z)).toBeCloseTo(REPO_RADIUS);
    expect(layout.repos.get("web")?.angle).toBeCloseTo(-Math.PI / 2);
    expect(layout.sectors.map((s) => s.label)).toEqual(["Frontends", "Libraries"]);
  });

  test("łuk warstwy jest proporcjonalny do liczby jej repo", () => {
    const layout = orbitLayout({
      layers: ["BFF", "Services"],
      repos: [repo("bff", 0), repo("a", 1), repo("b", 1), repo("c", 1)],
      sessions: [],
    });

    const [bff, services] = layout.sectors;
    expect((services?.span ?? 0) / (bff?.span ?? 1)).toBeCloseTo(3);
  });

  test("pusta warstwa nie dostaje łuku", () => {
    const layout = orbitLayout({ layers: ["Frontends", "BFF", "Libraries"], repos: [repo("web", 0), repo("lib", 2)], sessions: [] });

    expect(layout.sectors.map((s) => s.label)).toEqual(["Frontends", "Libraries"]);
  });

  test("sesje stoją na torze naprzeciw swojego repo, kilka sesji jednego repo obok siebie", () => {
    const layout = orbitLayout({
      layers: ["Services"],
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

  test("sesja repo spoza modelu nie ma miejsca na torze", () => {
    const layout = orbitLayout({
      layers: ["Services"],
      repos: [repo("orders", 0)],
      sessions: [{ id: "s1", repo: "removed", state: "working" }],
    });

    expect(layout.sessions.has("s1")).toBe(false);
  });

  test("repo z warstwą spoza listy warstw to błąd z nazwą repo", () => {
    expect(() => orbitLayout({ layers: ["Services"], repos: [repo("orders", 1)], sessions: [] })).toThrow("orders");
  });
});
