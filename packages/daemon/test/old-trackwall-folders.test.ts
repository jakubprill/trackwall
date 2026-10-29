import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { gitIn } from "./support/git-repo.ts";

/**
 * Moving the folders Trackwall kept in the projects folder before ADR-125 into `.trackwall`, through the real facade, on
 * a real projects folder and real git; the daemon runs the move at its start (`main.test.ts` shows that it does).
 */
async function setup() {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-old-folders-"));
  const logged: string[] = [];
  const log = (msg: string) => logged.push(msg);
  const facade = createFacade({
    home: mkdtempSync(join(tmpdir(), "trackwall-old-folders-home-")),
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: HOSTING_CLIS,
    userEnv: async () => process.env,
    log,
  });
  await facade.workspace.setProjectsDir(projects);
  return { projects, facade, logged, move: () => facade.workspace.moveOldTrackwallFolders(log) };
}

/** A local config store from before ADR-125: a git repo with one backup and a remote. */
function oldStore(projects: string): string {
  const store = join(projects, ".trackwall-local");
  mkdirSync(join(store, "orders"), { recursive: true });
  writeFileSync(join(store, "orders", "mise.local.toml"), "[tasks.dev]\nrun = 'echo dev'\n");
  gitIn(store, "init", "-q");
  gitIn(store, "add", ".");
  gitIn(store, "-c", "user.name=Trackwall", "-c", "user.email=trackwall@localhost", "commit", "-q", "-m", "Back up orders");
  gitIn(store, "remote", "add", "origin", "https://git.example.com/me/backups.git");
  return store;
}

describe("the folders from before .trackwall", () => {
  test("the local config store, removed repos, task indexes and scratch folder move into .trackwall, and the old folders go", async () => {
    const { projects, move } = await setup();
    oldStore(projects);
    mkdirSync(join(projects, ".trackwall-removed", "old-api"), { recursive: true });
    writeFileSync(join(projects, ".trackwall-removed", "old-api", "README.md"), "# old-api\n");
    mkdirSync(join(projects, ".trackwall-lsp", "task-1", "workspace"), { recursive: true });
    mkdirSync(join(projects, ".trackwall-scratch"));

    await move();

    const store = join(projects, ".trackwall", "local");
    expect(gitIn(store, "log", "--format=%s").trim()).toBe("Back up orders");
    expect(gitIn(store, "remote", "get-url", "origin").trim()).toBe("https://git.example.com/me/backups.git");
    expect(readFileSync(join(projects, ".trackwall", "removed", "old-api", "README.md"), "utf8")).toBe("# old-api\n");
    expect(existsSync(join(projects, ".trackwall", "lsp", "task-1", "workspace"))).toBe(true);
    for (const old of [".trackwall-local", ".trackwall-removed", ".trackwall-lsp", ".trackwall-scratch"])
      expect(existsSync(join(projects, old))).toBe(false);
  });

  test("a store that cannot move stays in use where it is, so backups do not start a second store, and moves at the next start", async () => {
    const { projects, facade, logged, move } = await setup();
    const store = oldStore(projects);
    // A file where the folder should go makes the move fail on every system, like a held file on Windows.
    writeFileSync(join(projects, ".trackwall"), "");

    await move();

    expect(logged.some((line) => line.startsWith(`${store} could not move to ${join(projects, ".trackwall", "local")}`))).toBe(true);
    expect((await facade.localConfig.store()).dir).toBe(store);

    rmSync(join(projects, ".trackwall"));
    await move();

    expect((await facade.localConfig.store()).dir).toBe(join(projects, ".trackwall", "local"));
    expect(gitIn(join(projects, ".trackwall", "local"), "log", "--format=%s").trim()).toBe("Back up orders");
    expect(existsSync(store)).toBe(false);
  });

  test("an entry that .trackwall already has stays in the old folder, which stays too", async () => {
    const { projects, logged, move } = await setup();
    mkdirSync(join(projects, ".trackwall-removed", "old-api"), { recursive: true });
    mkdirSync(join(projects, ".trackwall", "removed", "old-api"), { recursive: true });

    await move();

    expect(existsSync(join(projects, ".trackwall-removed", "old-api"))).toBe(true);
    expect(logged).toContain(
      `${join(projects, ".trackwall-removed", "old-api")} stays where it is: ${join(projects, ".trackwall", "removed", "old-api")} exists too`,
    );
  });

  test("the old default task worktrees folder goes once its tasks ended, while a worktree in it stays", async () => {
    const { projects, move } = await setup();
    mkdirSync(join(projects, ".trackwall-worktrees", "orders"), { recursive: true });

    await move();

    expect(existsSync(join(projects, ".trackwall-worktrees"))).toBe(false);

    mkdirSync(join(projects, ".trackwall-worktrees", "orders", "fix-login"), { recursive: true });
    writeFileSync(join(projects, ".trackwall-worktrees", "orders", "fix-login", "pom.xml"), "<project/>");
    mkdirSync(join(projects, ".trackwall-worktrees", "web"));

    await move();

    expect(existsSync(join(projects, ".trackwall-worktrees", "orders", "fix-login", "pom.xml"))).toBe(true);
    expect(existsSync(join(projects, ".trackwall-worktrees", "web"))).toBe(false);
  });

  test("an empty old worktrees folder that Settings names as the task worktrees folder stays", async () => {
    const { projects, facade, move } = await setup();
    mkdirSync(join(projects, ".trackwall-worktrees"));
    await facade.workspace.setWorktreesDir(join(projects, ".trackwall-worktrees"));

    await move();

    expect(existsSync(join(projects, ".trackwall-worktrees"))).toBe(true);
  });
});
