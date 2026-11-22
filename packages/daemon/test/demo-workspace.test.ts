import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TURNS } from "../scripts/demo/turns.ts";
import { createDemoWorkspace, DEMO_REPOS, DEMO_SERVICES } from "../scripts/demo/workspace.ts";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { fakeHosting } from "./support/hosting.ts";

/** Twenty repos with git and real card extraction take a few seconds. */
const DEMO_TIMEOUT = 60_000;

test(
  "the demo shop's graph shows every call between its services, and the shared libraries under them",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    const projects = mkdtempSync(join(tmpdir(), "trackwall-demo-"));
    createDemoWorkspace(projects);
    const vcs = new Vcs(systemTempFolder);
    const workspace = new Workspace({
      inContainer: false,
      file: new WorkspaceFile(join(home, "workspace.yaml")),
      vcs,
      hosting: fakeHosting().hosting,
      openEditor: () => {},
      openFolder: () => {},
      afterClone: async () => {},
    });
    await workspace.setProjectsDir(projects);
    const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}), log: () => {} });

    const { nodes, edges } = await new Graph({ cards, workspace }).graph();

    expect(nodes.map((node) => node.repo).sort()).toEqual([...DEMO_REPOS].sort());
    const httpCalls = edges.filter((edge) => edge.source === "http").map((edge) => `${edge.from} -> ${edge.to}`);
    const declaredCalls = DEMO_SERVICES.flatMap((service) => service.calls.map((to) => `${service.name} -> ${to}`));
    expect(httpCalls).toEqual(expect.arrayContaining(declaredCalls));
    const usesCommons = edges.filter((edge) => edge.kind === "depends-on" && edge.to === "shop-commons").map((edge) => edge.from);
    expect(usesCommons.sort()).toEqual(DEMO_SERVICES.map((service) => service.name).sort());
  },
  DEMO_TIMEOUT,
);

test(
  "the demo shop's repos track their branch on the invented host as fetched at the start: catalog and payments have commits to pull, and inventory has diverged",
  async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-demo-"));
    createDemoWorkspace(projects);
    const vcs = new Vcs(systemTempFolder);
    const server = async (repo: string) => {
      const { upstream, fetchedAt } = await vcs.status(join(projects, repo), "fresh");
      return { upstream, fetched: fetchedAt !== null, remote: await vcs.remote(join(projects, repo)) };
    };

    expect(await server("catalog")).toEqual({
      upstream: { name: "origin/main", ahead: 0, behind: 15 },
      fetched: true,
      remote: "git.example.com/shop/catalog",
    });
    expect(await server("payments")).toEqual({
      upstream: { name: "origin/main", ahead: 0, behind: 2 },
      fetched: true,
      remote: "git.example.com/shop/payments",
    });
    expect(await server("inventory")).toEqual({
      upstream: { name: "origin/main", ahead: 1, behind: 3 },
      fetched: true,
      remote: "git.example.com/shop/inventory",
    });
    expect(await server("auth")).toEqual({
      upstream: { name: "origin/main", ahead: 0, behind: 0 },
      fetched: true,
      remote: "git.example.com/shop/auth",
    });
  },
  DEMO_TIMEOUT,
);

test("every demo session runs in a repo of the demo shop", () => {
  expect(Object.keys(TURNS).filter((repo) => !DEMO_REPOS.includes(repo))).toEqual([]);
});
