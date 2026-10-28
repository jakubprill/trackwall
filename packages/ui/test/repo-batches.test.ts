import { describe, expect, test } from "bun:test";
import type { Repo } from "@trackwall/protocol";
import { repoBatches, withLoadedRepos } from "../src/lib/repo-batches.ts";

describe("lazy loading of the repo list (ADR-113)", () => {
  test("the repos the view shows come first, then the rest in list order, in batches, every repo once", () => {
    expect(repoBatches(["api", "bff", "orders", "payments", "web"], ["web", "api", "web"], 2)).toEqual([
      ["web", "api"],
      ["bff", "orders"],
      ["payments"],
    ]);
  });

  test("a repo asked first that is not on the list is left out", () => {
    expect(repoBatches(["api", "web"], ["gone", "web"], 8)).toEqual([["web", "api"]]);
  });

  test("an empty list has no batches", () => {
    expect(repoBatches([], ["api"], 8)).toEqual([]);
  });

  test("a loaded repo replaces its loading entry, and a repo not loaded yet stays loading in its place", () => {
    const loading = (id: string): Repo => ({ id, path: `/projects/${id}`, remote: null, status: { kind: "loading" } });
    const api: Repo = { ...loading("api"), remote: "git.example.com/shop/api", status: { kind: "unavailable", message: "broken" } };
    const removed: Repo = { ...loading("removed"), status: { kind: "unavailable", message: "gone" } };

    expect(
      withLoadedRepos(
        [loading("api"), loading("web")],
        new Map([
          ["api", api],
          ["removed", removed],
        ]),
      ),
    ).toEqual([api, loading("web")]);
  });
});
