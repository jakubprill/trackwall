import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { CardWarmup, type WarmupRepo } from "../src/modules/cards/card-warmup.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** A warm-up whose repos finish only when the test says so. */
function controlled(concurrency = 2) {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const warmup = new CardWarmup({
    concurrency,
    log: () => {},
    warm: (repo) =>
      new Promise<void>((resolve) => {
        started.push(repo.id);
        finish.set(repo.id, resolve);
      }),
  });
  const done = async (id: string) => {
    const resolve = finish.get(id);
    if (!resolve) throw new Error(`${id} has not started`);
    resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { warmup, started, done };
}

const repo = (id: string): WarmupRepo => ({ id, path: `/projects/${id}` });

describe("the card warm-up", () => {
  test("computes two repos at once in the order handed over and counts the finished ones", async () => {
    const { warmup, started, done } = controlled();
    expect(warmup.progress()).toEqual({ running: false, done: 0, total: 0 });

    warmup.add([repo("a"), repo("b"), repo("c")]);
    expect(started).toEqual(["a", "b"]);
    expect(warmup.progress()).toEqual({ running: true, done: 0, total: 3 });

    await done("a");
    expect(started).toEqual(["a", "b", "c"]);
    await done("b");
    await done("c");
    expect(warmup.progress()).toEqual({ running: false, done: 3, total: 3 });
  });

  test("repos handed over later go before the waiting ones, and a waiting repo handed over again moves to the front once", async () => {
    const { warmup, started, done } = controlled(1);
    warmup.add([repo("a"), repo("b"), repo("c")]);
    warmup.add([repo("changed"), repo("c")]);
    expect(warmup.progress().total).toBe(4);

    await done("a");
    await done("changed");
    await done("c");
    await done("b");
    expect(started).toEqual(["a", "changed", "c", "b"]);
  });

  test("a closed warm-up starts nothing more", async () => {
    const { warmup, started, done } = controlled(1);
    warmup.add([repo("a"), repo("b")]);
    warmup.close();
    warmup.add([repo("c")]);
    await done("a");
    expect(started).toEqual(["a"]);
    expect(warmup.progress().running).toBe(false);
  });

  test("a repo being computed is queued again, because its HEAD has moved meanwhile", async () => {
    const { warmup, started, done } = controlled(1);
    warmup.add([repo("a")]);
    warmup.add([repo("a")]);
    await done("a");
    expect(started).toEqual(["a", "a"]);
    await done("a");
    expect(warmup.progress()).toEqual({ running: false, done: 2, total: 2 });
  });

  test("a new round after an idle warm-up counts from zero", async () => {
    const { warmup, done } = controlled();
    warmup.add([repo("a")]);
    await done("a");
    warmup.add([repo("b")]);
    expect(warmup.progress()).toEqual({ running: true, done: 0, total: 1 });
    await done("b");
  });

  test("a failing repo counts as done, goes to the log once and does not stop the others", async () => {
    const seen: string[] = [];
    const logs: string[] = [];
    const warmup = new CardWarmup({
      log: (msg) => logs.push(msg),
      warm: async (r) => {
        seen.push(r.id);
        if (r.id === "broken") throw new Error("git cannot read the repo");
      },
    });
    warmup.add([repo("broken"), repo("ok")]);
    while (warmup.progress().running) await new Promise((r) => setTimeout(r, 1));
    warmup.add([repo("broken")]);
    while (warmup.progress().running) await new Promise((r) => setTimeout(r, 1));

    expect(seen).toEqual(["broken", "ok", "broken"]);
    expect(logs).toEqual(["card warm-up of broken: git cannot read the repo"]);
    expect(warmup.progress()).toEqual({ running: false, done: 1, total: 1 });
  });

  test("a warmed-up card is in the cache, so a request after it does not read files from git", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const vcs = new Vcs(systemTempFolder);
    const workspace = new Workspace({
      file: new WorkspaceFile(join(home, "workspace.yaml")),
      vcs,
      hosting: fakeHosting().hosting,
      openEditor: () => {},
      openFolder: () => {},
    });
    await workspace.setProjectsDir(projects);
    const path = makeRepo({ "package.json": JSON.stringify({ name: "web", private: true }) }, "web", projects);
    const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}), log: () => {} });

    cards.warmUp([{ id: "web", path }]);
    while (cards.warmupProgress().running) await new Promise((r) => setTimeout(r, 10));
    vcs.commitFiles = () => Promise.reject(new Error("should not read files"));

    expect((await cards.card("web")).card?.buildFiles.map((f) => f.path)).toEqual(["package.json"]);
    expect(cards.warmupProgress()).toEqual({ running: false, done: 1, total: 1 });
  });
});
