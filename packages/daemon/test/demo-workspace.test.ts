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

test("every demo session runs in a repo of the demo shop", () => {
  expect(Object.keys(TURNS).filter((repo) => !DEMO_REPOS.includes(repo))).toEqual([]);
});
