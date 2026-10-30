import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { Graph } from "../src/modules/graph/graph.ts";
import { gitProcessesStarted } from "../src/modules/vcs/git.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
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

/** Longer than any reuse of a status (ADR-141): after it every list reads git again. */
const PAST_ANY_REUSE_MS = 10 * 60_000;

async function folderOfTwentyRepos() {
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  // The status memo's clock stands still unless a test moves it, so a read takes no time and is reused for the shortest window.
  const clock = { ms: 0 };
  const vcs = new Vcs(systemTempFolder, () => clock.ms);
  const workspace = new Workspace({
    file: new WorkspaceFile(join(home, "workspace.yaml")),
    vcs,
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
    afterClone: async () => {},
  });
  await workspace.setProjectsDir(projects);
  const repos = Array.from({ length: REPO_COUNT }, (_, i) => {
    const name = SHOP[i % SHOP.length] ?? "repo";
    const dir = makeRepo(fixtureFiles(name), `${name}-${i}`, projects);
    gitIn(dir, "remote", "add", "origin", `https://git.example.com/shop/${name}-${i}.git`);
    return dir;
  });
  const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(join(home, "cards"), () => {}), log: () => {} });
  const later = () => {
    clock.ms += PAST_ANY_REUSE_MS;
  };
  return { repos, workspace, cards, graph: new Graph({ cards, workspace }), later };
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
      const { workspace, cards, graph, later } = await folderOfTwentyRepos();
      await workspace.list("recent");
      await cards.tags();
      later();

      expect(await gitProcessesOf(() => workspace.list("recent"))).toBe(REPO_COUNT);
      expect(await gitProcessesOf(() => cards.tags())).toBe(0);
      expect(await gitProcessesOf(() => graph.graph())).toBe(0);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "the quick list starts no git process, and repos asks git only for the repos named (ADR-113)",
    async () => {
      const { repos, workspace, later } = await folderOfTwentyRepos();
      await workspace.list("recent");
      const ids = (await workspace.entryList()).repos.map((r) => r.id);
      later();

      expect(await gitProcessesOf(() => workspace.entryList())).toBe(0);
      expect(await gitProcessesOf(() => workspace.repos(ids.slice(0, 3), "recent"))).toBe(3);
      expect(repos).toHaveLength(REPO_COUNT);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "two repo lists asked at once share every git status that has not started yet",
    async () => {
      const { workspace, later } = await folderOfTwentyRepos();
      await workspace.list("recent");
      later();

      // A status that already started when the second list asks runs again (WaitingCalls). How many did depends on how fast
      // git is here; but the first batches of both lists ask before the slots can take them all, so some are always shared.
      const processes = await gitProcessesOf(() => Promise.all([workspace.list("recent"), workspace.list("recent")]));
      expect(processes).toBeGreaterThanOrEqual(REPO_COUNT);
      expect(processes).toBeLessThan(2 * REPO_COUNT);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "after a commit in one repo only that repo costs more: its new HEAD commit in the list, its new card in the graph",
    async () => {
      const { repos, workspace, cards, graph, later } = await folderOfTwentyRepos();
      await workspace.list("recent");
      await graph.graph();
      const [changed] = repos;
      if (!changed) throw new Error("no repos");
      commitFiles(changed, { "NOTES.md": "notes" }, "add notes");
      later();

      expect(await gitProcessesOf(() => workspace.list("recent"))).toBe(REPO_COUNT + 1);
      const graphProcesses = await gitProcessesOf(() => graph.graph());
      expect(graphProcesses).toBeGreaterThan(0);
      expect(graphProcesses).toBeLessThan(REPO_COUNT);
      expect(await gitProcessesOf(() => cards.tags())).toBe(0);
      const listed = (await workspace.list("recent")).repos.find((r) => r.path === changed);
      expect(listed?.status.kind === "ok" && listed.status.head?.subject).toBe("add notes");
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a remote address changed in the repo's config shows at the next refresh",
    async () => {
      const { repos, workspace, later } = await folderOfTwentyRepos();
      await workspace.list("recent");
      const [changed] = repos;
      if (!changed) throw new Error("no repos");
      later();
      gitIn(changed, "remote", "set-url", "origin", "https://git.example.com/moved/orders-api.git");

      const listed = (await workspace.list("recent")).repos.find((r) => r.path === changed);
      expect(listed?.remote).toBe("git.example.com/moved/orders-api");
    },
    REAL_GIT_TIMEOUT,
  );
});

describe("statuses the lists reuse while git has no reason to see a change (ADR-141)", () => {
  test(
    "a list soon after another starts no git process, and a commit or staging in one repo reads only that repo again",
    async () => {
      const { repos, workspace } = await folderOfTwentyRepos();
      await workspace.list("recent");
      const [committed, staged] = repos;
      if (!committed || !staged) throw new Error("no repos");

      expect(await gitProcessesOf(() => workspace.list("recent"))).toBe(0);
      commitFiles(committed, { "NOTES.md": "notes" }, "add notes");
      writeFileSync(join(staged, "STAGED.md"), "staged");
      gitIn(staged, "add", "STAGED.md");
      // The commit's repo: its status and its new HEAD commit; the staged repo: its status.
      expect(await gitProcessesOf(() => workspace.list("recent"))).toBe(3);
      const listed = (await workspace.list("recent")).repos;
      const statusOf = (dir: string) => listed.find((r) => r.path === dir)?.status;
      expect(statusOf(committed)).toMatchObject({ kind: "ok", head: { subject: "add notes" } });
      expect(statusOf(staged)).toMatchObject({ kind: "ok", changes: 1 });
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "an edit in the working directory shows in the list once the reuse ends, and at once in the repo asked for by itself",
    async () => {
      const { repos, workspace, later } = await folderOfTwentyRepos();
      const before = await workspace.list("recent");
      const [edited] = repos;
      if (!edited) throw new Error("no repos");
      const id = before.repos.find((r) => r.path === edited)?.id ?? "";
      writeFileSync(join(edited, "NEW.md"), "new");
      const statusOf = async () => (await workspace.list("recent")).repos.find((r) => r.path === edited)?.status;

      expect(await statusOf()).toMatchObject({ kind: "ok", changes: 0 });
      expect(await gitProcessesOf(() => workspace.repo(id))).toBe(1);
      expect((await workspace.repo(id)).status).toMatchObject({ kind: "ok", changes: 1, untracked: 1 });
      expect(await statusOf()).toMatchObject({ kind: "ok", changes: 1 });

      writeFileSync(join(edited, "OTHER.md"), "other");
      expect(await statusOf()).toMatchObject({ kind: "ok", changes: 1 });
      later();
      expect(await statusOf()).toMatchObject({ kind: "ok", changes: 2 });
    },
    REAL_GIT_TIMEOUT,
  );
});
