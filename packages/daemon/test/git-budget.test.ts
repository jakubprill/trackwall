import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import { gitProcessesStarted } from "../src/modules/vcs/git.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

/**
 * The git budget of the views that refresh after every repo change (ADR-63, ADR-79): where an antivirus scans each process
 * start, every git process costs about a second, so a refresh of a projects folder with 20 repos must not start a few of
 * them per repo. Counted, not timed, so the test means the same on every machine.
 */

const SHOP = ["orders-api", "orders-bff", "payments", "legacy-reports", "shop-web"];
const REPO_COUNT = 20;
// Twenty repos made and their cards computed on real git take a while on Windows in CI.
const REAL_GIT_TIMEOUT = 120_000;

async function folderOfTwentyRepos() {
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const vcs = new Vcs();
  const workspace = new Workspace({
    file: new WorkspaceFile(join(home, "workspace.yaml")),
    vcs,
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
  });
  await workspace.setProjectsDir(projects);
  const repos = Array.from({ length: REPO_COUNT }, (_, i) => {
    const name = SHOP[i % SHOP.length] ?? "repo";
    const dir = makeRepo(fixtureFiles(name), `${name}-${i}`, projects);
    gitIn(dir, "remote", "add", "origin", `https://git.example.com/shop/${name}-${i}.git`);
    return dir;
  });
  const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}), log: () => {} });
  return { repos, workspace, cards, graph: new Graph({ cards, workspace }) };
}

async function gitProcessesOf(work: () => Promise<unknown>): Promise<number> {
  const before = gitProcessesStarted();
  await work();
  return gitProcessesStarted() - before;
}

describe("the git budget of a refresh with 20 repos", () => {
  test(
    "the repo list starts one git process per repo, and the tags and the graph from cached cards none",
    async () => {
      const { workspace, cards, graph } = await folderOfTwentyRepos();
      await workspace.list();
      await cards.tags();

      expect(await gitProcessesOf(() => workspace.list())).toBe(REPO_COUNT);
      expect(await gitProcessesOf(() => cards.tags())).toBe(0);
      expect(await gitProcessesOf(() => graph.graph())).toBe(0);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "after a commit in one repo only that repo costs more: its new HEAD commit in the list, its new card in the graph",
    async () => {
      const { repos, workspace, cards, graph } = await folderOfTwentyRepos();
      await workspace.list();
      await graph.graph();
      const [changed] = repos;
      if (!changed) throw new Error("no repos");
      commitFiles(changed, { "NOTES.md": "notes" }, "add notes");

      expect(await gitProcessesOf(() => workspace.list())).toBe(REPO_COUNT + 1);
      const graphProcesses = await gitProcessesOf(() => graph.graph());
      expect(graphProcesses).toBeGreaterThan(0);
      expect(graphProcesses).toBeLessThan(REPO_COUNT);
      expect(await gitProcessesOf(() => cards.tags())).toBe(0);
      const listed = (await workspace.list()).repos.find((r) => r.path === changed);
      expect(listed?.status.kind === "ok" && listed.status.head?.subject).toBe("add notes");
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a remote address changed in the repo's config shows at the next refresh",
    async () => {
      const { repos, workspace } = await folderOfTwentyRepos();
      await workspace.list();
      const [changed] = repos;
      if (!changed) throw new Error("no repos");
      gitIn(changed, "remote", "set-url", "origin", "https://git.example.com/moved/orders-api.git");

      const listed = (await workspace.list()).repos.find((r) => r.path === changed);
      expect(listed?.remote).toBe("git.example.com/moved/orders-api");
    },
    REAL_GIT_TIMEOUT,
  );
});
