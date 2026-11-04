import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade } from "../src/facade.ts";
import { makeRepo } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";
import { fixtureFiles } from "./support/spring-fixtures.ts";

const fakeMise = join(import.meta.dir, "fixtures", "fake-mise.ts");

/** A facade on a projects folder of real git repos, with the fake mise (`fake-mise.json` in each repo, outside git). */
async function facadeOn(projects: string) {
  const facade = createFacade({
    inContainer: false,
    home: mkdtempSync(join(tmpdir(), "trackwall-readiness-home-")),
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: [process.execPath, fakeMise],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => process.env,
    tlsProbe: async () => ({ kind: "ok" }),
    diskSpace: async () => ({ disk: 1, free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }),
    log: () => {},
  });
  await facade.workspace.setProjectsDir(projects);
  return facade;
}

function repoWithMise(projects: string, id: string, files: Record<string, string>, mise: object): string {
  const dir = makeRepo(files, id, projects);
  writeFileSync(join(dir, "fake-mise.json"), JSON.stringify(mise));
  return dir;
}

const BUILD_AND_TEST = [{ name: "build" }, { name: "test" }];
const PACKAGE_JSON = '{ "name": "admin-web", "scripts": { "build": "vite build" } }\n';

describe("readiness of the repos in the projects folder, from the cards, the graph and mise", () => {
  test("each repo gets the gaps that stand in an agent's way, and trusting a config in Trackwall clears its gap without a fresh check", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-readiness-"));
    repoWithMise(projects, "admin-web", { "package.json": PACKAGE_JSON }, { tasks: BUILD_AND_TEST });
    repoWithMise(projects, "notify-worker", { "package.json": PACKAGE_JSON }, { tasks: [{ name: "build" }] });
    repoWithMise(projects, "orders-bff", fixtureFiles("orders-bff"), { tasks: BUILD_AND_TEST });
    repoWithMise(projects, "shop-web", { "package.json": PACKAGE_JSON }, { tasks: BUILD_AND_TEST, untrusted: true });
    const facade = await facadeOn(projects);

    const report = await facade.readiness.all(false);

    expect(report.conventionTasks).toBe("absent");
    expect(report.repos.map((r) => [r.repo, r.state, r.gaps.map((g) => g.code)])).toEqual([
      ["admin-web", "ready", []],
      ["notify-worker", "blocked", ["no-build-test"]],
      ["orders-bff", "gaps", ["no-dev", "unresolved-call", "card-incomplete"]],
      ["shop-web", "blocked", ["mise-untrusted"]],
    ]);

    await facade.mise.trust("shop-web");
    const afterTrust = await facade.readiness.all(false);

    expect(afterTrust.repos.find((r) => r.repo === "shop-web")).toEqual({ repo: "shop-web", state: "ready", gaps: [] });
  }, 30_000);

  test("a change mise sees without a new commit shows after a fresh check, and one repo is always asked again", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-readiness-fresh-"));
    const dir = repoWithMise(projects, "admin-web", { "package.json": PACKAGE_JSON }, { tasks: [{ name: "build" }] });
    const facade = await facadeOn(projects);
    expect((await facade.readiness.all(false)).repos[0]?.state).toBe("blocked");

    // A mise task added in a file only this clone has, such as `mise.local.toml`: no new commit.
    writeFileSync(join(dir, "fake-mise.json"), JSON.stringify({ tasks: BUILD_AND_TEST }));

    expect((await facade.readiness.all(false)).repos[0]?.state).toBe("blocked");
    expect((await facade.readiness.all(true)).repos[0]?.state).toBe("ready");
    writeFileSync(join(dir, "fake-mise.json"), JSON.stringify({ tasks: [] }));
    expect((await facade.readiness.repo("admin-web")).state).toBe("blocked");
  }, 30_000);

  test("a repo not in the projects folder is not found", async () => {
    const facade = await facadeOn(mkdtempSync(join(tmpdir(), "trackwall-readiness-empty-")));

    await expect(facade.readiness.repo("no-such-repo")).rejects.toThrow('no repo "no-such-repo" in the projects folder');
  });
});
