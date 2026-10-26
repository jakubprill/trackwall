import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

/**
 * The local config store (ADR-86) through the real facade, on a real projects folder and real git; the test runs each
 * backup itself instead of the timer, and waits for the store's push with `settled`.
 */
async function setup() {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const logged: string[] = [];
  const facade = createFacade({
    home: mkdtempSync(join(tmpdir(), "trackwall-home-")),
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["mise"],
    copilotCommand: ["copilot"],
    version: "0.0.0-test",
    hookCommand: () => ({ exec: "true", args: [] }),
    sessionMcpCommand: (tokenFile) => ["trackwall-daemon", "mcp-stdio", "--session-token-file", tokenFile],
    hostingClis: HOSTING_CLIS,
    userEnv: async () => process.env,
    log: (msg) => logged.push(msg),
  });
  await facade.workspace.setProjectsDir(projects);
  const store = join(projects, ".trackwall-local");
  const backUp = async () => {
    await facade.localConfig.backUp();
    await facade.localConfig.settled();
  };
  const storeLog = () => gitIn(store, "log", "--format=%an|%s", "--name-only").trim();
  const storeCommits = () => Number(gitIn(store, "rev-list", "--count", "HEAD").trim());
  return { projects, store, facade, logged, backUp, storeLog, storeCommits };
}

const TASKS = '[tasks.build]\nrun = "mvn -q package"\n';

describe("the local config store", () => {
  test("a repo's mise.local.toml and .worktreeinclude land in the store as a commit by Trackwall, and the repo list skips the store", async () => {
    const { projects, store, facade, backUp, storeLog } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    writeFileSync(join(orders, "mise.local.toml"), TASKS);
    writeFileSync(join(orders, ".worktreeinclude"), "mise.local.toml\n");

    await backUp();

    expect(readFileSync(join(store, "orders", "mise.local.toml"), "utf8")).toBe(TASKS);
    expect(storeLog()).toBe(
      "Trackwall|Back up orders: .worktreeinclude, mise.local.toml\n\norders/.worktreeinclude\norders/mise.local.toml",
    );
    expect((await facade.workspace.list()).repos.map((r) => r.id)).toEqual(["orders"]);
  });

  test("without a change nothing is committed, and a changed file is a new commit", async () => {
    const { projects, store, backUp, storeCommits } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    writeFileSync(join(orders, "mise.local.toml"), TASKS);
    await backUp();
    await backUp();
    expect(storeCommits()).toBe(1);

    const changed = `${TASKS}[tasks.dev]\nrun = "mvn spring-boot:run"\n`;
    writeFileSync(join(orders, "mise.local.toml"), changed);
    await backUp();

    expect(storeCommits()).toBe(2);
    expect(readFileSync(join(store, "orders", "mise.local.toml"), "utf8")).toBe(changed);
  });

  test("a file the repo's commits have is not local config and stays out of the store", async () => {
    const { projects, store, facade, backUp } = await setup();
    makeRepo({ ".worktreeinclude": ".env\n" }, "web", projects);

    await backUp();

    expect(existsSync(join(store, "web"))).toBe(false);
    expect((await facade.localConfig.repo("web")).files).toEqual([
      { kind: "absent", file: "mise.local.toml" },
      { kind: "tracked", file: ".worktreeinclude" },
    ]);
  });

  test("a file deleted from the repo stays in the store, and Restore brings it back and has git ignore it", async () => {
    const { projects, facade, backUp } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    writeFileSync(join(orders, "mise.local.toml"), TASKS);
    await backUp();
    expect((await facade.localConfig.repo("orders")).files[0]).toEqual({ kind: "backed_up", file: "mise.local.toml", ignored: false });

    // A new clone: the folder is gone and comes back without the file.
    rmSync(orders, { recursive: true, force: true });
    makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    await backUp();
    expect((await facade.localConfig.repo("orders")).files[0]).toEqual({ kind: "missing", file: "mise.local.toml" });

    const restored = await facade.localConfig.restore("orders");

    expect(readFileSync(join(orders, "mise.local.toml"), "utf8")).toBe(TASKS);
    expect(restored.files[0]).toEqual({ kind: "backed_up", file: "mise.local.toml", ignored: true });
    expect(readFileSync(join(orders, ".git", "info", "exclude"), "utf8")).toEndWith("\n/mise.local.toml\n");
    expect(gitIn(orders, "status", "--porcelain")).toBe("");
  });

  test("Ignore adds the unignored local config files to info/exclude once, keeping the user's lines", async () => {
    const { projects, facade } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    writeFileSync(join(orders, "mise.local.toml"), TASKS);
    writeFileSync(join(orders, ".worktreeinclude"), "mise.local.toml\n");
    writeFileSync(join(orders, ".git", "info", "exclude"), "# mine\n*.log");

    await facade.localConfig.ignore("orders");
    const again = await facade.localConfig.ignore("orders");

    expect(readFileSync(join(orders, ".git", "info", "exclude"), "utf8")).toBe("# mine\n*.log\n/mise.local.toml\n/.worktreeinclude\n");
    expect(again.files.map((f) => (f.kind === "pending" || f.kind === "backed_up" ? f.ignored : f.kind))).toEqual([true, true]);
  });

  test("a task worktree ignores the restored file too, because info/exclude is shared with the repo", async () => {
    const { projects, facade } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    writeFileSync(join(orders, "mise.local.toml"), TASKS);
    await facade.localConfig.ignore("orders");
    const worktree = join(mkdtempSync(join(tmpdir(), "trackwall-worktree-")), "task");
    gitIn(orders, "worktree", "add", "-q", "-b", "task", worktree);

    writeFileSync(join(worktree, "mise.local.toml"), TASKS);

    expect(gitIn(worktree, "status", "--porcelain")).toBe("");
  });

  test("Restore refuses a repo the store has nothing for", async () => {
    const { projects, facade } = await setup();
    makeRepo({ "pom.xml": "<project/>" }, "orders", projects);

    await expect(facade.localConfig.restore("orders")).rejects.toThrow("the local config store has nothing this repo lacks");
  });

  test("the store pushes each backup to its remote, and a push the remote refuses is shown with the store, never forced", async () => {
    const { projects, store, facade, backUp } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    writeFileSync(join(orders, "mise.local.toml"), TASKS);
    await backUp();
    const remote = join(mkdtempSync(join(tmpdir(), "trackwall-backups-")), "backups.git");
    gitIn(projects, "init", "-q", "--bare", remote);
    gitIn(store, "remote", "add", "origin", remote);

    writeFileSync(join(orders, "mise.local.toml"), `${TASKS}# second\n`);
    await backUp();

    expect(gitIn(remote, "log", "--format=%s", "main").trim().split("\n")).toEqual([
      "Back up orders: mise.local.toml",
      "Back up orders: mise.local.toml",
    ]);
    const pushed = await facade.localConfig.store();
    expect(pushed).toMatchObject({ dir: store, remote, push: { kind: "ok" }, problem: null });
    expect(pushed.lastBackup?.subject).toBe("Back up orders: mise.local.toml");

    // Another computer pushed first: the push is refused, never forced.
    const other = join(mkdtempSync(join(tmpdir(), "trackwall-other-")), "store");
    gitIn(projects, "clone", "-q", "-b", "main", remote, other);
    commitFiles(other, { "web/mise.local.toml": TASKS }, "Back up web: mise.local.toml");
    gitIn(other, "push", "-q", "origin", "main");
    writeFileSync(join(orders, "mise.local.toml"), `${TASKS}# third\n`);
    await backUp();

    expect(await facade.localConfig.store()).toMatchObject({ push: { kind: "failed" } });
    expect(gitIn(remote, "log", "-1", "--format=%s", "main").trim()).toBe("Back up web: mise.local.toml");
  });

  test("a link in place of a local config file is not followed, and the problem is logged once and shown with the store", async () => {
    const { projects, store, facade, logged, backUp } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    const secret = join(mkdtempSync(join(tmpdir(), "trackwall-secret-")), "secret.toml");
    writeFileSync(secret, "token = 'x'\n");
    try {
      symlinkSync(secret, join(orders, "mise.local.toml"));
    } catch {
      // Windows without the right to create links: there is nothing to follow.
      return;
    }

    await backUp();
    await backUp();

    expect(existsSync(join(store, "orders"))).toBe(false);
    expect((await facade.localConfig.store()).problem).toContain("mise.local.toml is not a regular file");
    expect(logged).toHaveLength(1);
  });

  test("without a projects folder there is no store and nothing to back up", async () => {
    const facade = createFacade({
      home: mkdtempSync(join(tmpdir(), "trackwall-home-")),
      openUrl: () => {},
      openFolder: () => {},
      miseCommand: ["mise"],
      copilotCommand: ["copilot"],
      version: "0.0.0-test",
      hookCommand: () => ({ exec: "true", args: [] }),
      sessionMcpCommand: (tokenFile) => ["trackwall-daemon", "mcp-stdio", "--session-token-file", tokenFile],
      hostingClis: HOSTING_CLIS,
      userEnv: async () => process.env,
      log: () => {},
    });

    await facade.localConfig.backUp();

    expect(await facade.localConfig.store()).toEqual({ dir: null, lastBackup: null, remote: null, push: { kind: "none" }, problem: null });
  });

  test("mise tasks in mise.local.toml take away the no-mise tag the commit alone gives", async () => {
    const { projects, facade } = await setup();
    const orders = makeRepo({ "pom.xml": "<project/>" }, "orders", projects);
    const tagNames = async () => (await facade.cards.card("orders")).tags.map((t) => t.name);
    expect(await tagNames()).toContain("no-mise");

    writeFileSync(join(orders, "mise.local.toml"), TASKS);

    expect(await tagNames()).not.toContain("no-mise");
  });
});
