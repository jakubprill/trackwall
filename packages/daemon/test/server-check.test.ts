import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFacade, type Facade } from "../src/facade.ts";
import { gitProcessesStarted } from "../src/modules/vcs/git.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";

const FAKE_SSH = join(import.meta.dir, "fixtures", "fake-ssh.ts");
/** A made-up host: the user's own git configuration sends it to the fake ssh, which serves the bare repos on disk. */
const SERVER = "ssh://git@git.example.test";
/** For tests that start dozens of real git processes, which on a Windows runner take longer than the default 5 s. */
const REAL_GIT_TIMEOUT = 60_000;

let root: string;
let savedGlobalConfig: string | undefined;

/**
 * The server check asks with the user's and the system's configuration alone (ADR-295), so the fake ssh goes into the
 * user's own configuration (`GIT_CONFIG_GLOBAL`), where a repo's configuration cannot override it unless git ran in the repo.
 */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trackwall-server-check-"));
  const userConfig = join(root, "user.gitconfig");
  const quoted = (path: string) => `"${path.replaceAll("\\", "/")}"`;
  execFileSync("git", ["config", "--file", userConfig, "core.sshCommand", [process.execPath, FAKE_SSH, serverDir()].map(quoted).join(" ")]);
  execFileSync("git", ["config", "--file", userConfig, "ssh.variant", "simple"]);
  savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = userConfig;
  setSystemTime(new Date("2026-11-22T10:00:00.000Z"));
});

afterEach(() => {
  if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
  setSystemTime();
});

function serverDir(): string {
  return join(root, "server");
}

/**
 * A bare repo `me/<name>.git` on the made-up server, and a clone of it in the projects folder over SSH, with more
 * configuration of the clone's own (`key=value`) set after the clone; `push` adds a commit to the server only.
 */
function cloneFromServer(projects: string, name: string, config: string[] = []) {
  const bare = join(serverDir(), "me", `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const elsewhere = makeRepo({ "README.md": `# ${name}\n` }, name);
  gitIn(elsewhere, "push", "-q", bare, "main");
  const clone = join(projects, name);
  gitIn(projects, "clone", "-q", `${SERVER}/me/${name}.git`, clone);
  for (const entry of config) {
    const [key = "", ...value] = entry.split("=");
    gitIn(clone, "config", key, value.join("="));
  }
  return {
    clone,
    bare,
    push: (message: string) => {
      commitFiles(elsewhere, { "CHANGELOG.md": `${message}\n` }, message);
      gitIn(elsewhere, "push", "-q", bare, "main");
    },
  };
}

async function facadeOn(
  projects: string,
  {
    home = mkdtempSync(join(tmpdir(), "trackwall-server-check-home-")),
    log = () => {},
  }: { home?: string; log?: (msg: string) => void } = {},
): Promise<Facade> {
  const facade = createFacade({
    inContainer: false,
    home,
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => process.env,
    tlsProbe: async () => ({ kind: "ok" }),
    diskSpace: async () => ({ disk: 1, free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }),
    log,
  });
  await facade.workspace.setProjectsDir(projects);
  return facade;
}

/** Runs `ask` with the fake ssh adding a line per connection to `log`. */
async function askedWithConnectionsIn(log: string, ask: () => Promise<void>): Promise<void> {
  process.env.TRACKWALL_FAKE_SSH_LOG = log;
  try {
    await ask();
  } finally {
    delete process.env.TRACKWALL_FAKE_SSH_LOG;
  }
}

/** Waits up to 20 s for what the check's timer does; the tests' `Date` stands still, so the waits are counted. */
async function until(done: () => boolean): Promise<void> {
  for (let waitedMs = 0; !done(); waitedMs += 10) {
    if (waitedMs > 20_000) throw new Error("gave up waiting for the server check's timer");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the server check asks real git servers for new commits without fetching them (ADR-295)", () => {
  test(
    "a commit pushed to the server shows at the next round, 15 minutes on, and a fetch takes it away",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-server-check-projects-"));
      const shop = cloneFromServer(projects, "shop");
      const facade = await facadeOn(projects);

      await facade.serverCheck.checkIfDue();
      expect(facade.serverCheck.state()).toEqual({
        on: true,
        last: { endedAt: "2026-11-22T10:00:00.000Z", newCommits: [], unreached: [] },
      });

      shop.push("Add a discount for big orders");
      setSystemTime(new Date("2026-11-22T10:14:00.000Z"));
      await facade.serverCheck.checkIfDue();
      expect(facade.serverCheck.state().last?.newCommits).toEqual([]);

      setSystemTime(new Date("2026-11-22T10:15:00.000Z"));
      await facade.serverCheck.checkIfDue();
      expect(facade.serverCheck.state().last).toEqual({
        endedAt: "2026-11-22T10:15:00.000Z",
        newCommits: [{ repo: "shop", checkedAt: "2026-11-22T10:15:00.000Z", remoteBranches: ["origin/main"] }],
        unreached: [],
      });
      // Nothing was fetched: the repo has no FETCH_HEAD, and its branch lacks nothing as far as it knows.
      expect(existsSync(join(shop.clone, ".git", "FETCH_HEAD"))).toBe(false);
      const [listed] = await facade.workspace.repos(["shop"], "fresh");
      expect(listed?.status).toMatchObject({ kind: "ok", upstream: { name: "origin/main", ahead: 0, behind: 0 }, fetchedAt: null });

      gitIn(shop.clone, "fetch", "-q");
      setSystemTime(new Date("2026-11-22T10:30:00.000Z"));
      await facade.serverCheck.checkIfDue();
      expect(facade.serverCheck.state().last?.newCommits).toEqual([]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "with another branch checked out it also asks about the default branch, where a new task starts, in the same connection (ADR-296)",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-server-check-default-"));
      const shop = cloneFromServer(projects, "shop");
      gitIn(shop.clone, "checkout", "-q", "-b", "discounts");
      gitIn(shop.clone, "push", "-q", "-u", "origin", "discounts");
      shop.push("Add a discount for big orders");
      const facade = await facadeOn(projects);
      const connections = join(root, "ssh.log");

      await askedWithConnectionsIn(connections, () => facade.serverCheck.checkIfDue());
      expect(facade.serverCheck.state().last?.newCommits).toEqual([
        { repo: "shop", checkedAt: "2026-11-22T10:00:00.000Z", remoteBranches: ["origin/main"] },
      ]);

      const colleague = join(root, "colleague");
      gitIn(root, "clone", "-q", "-b", "discounts", shop.bare, colleague);
      commitFiles(colleague, { "discounts.txt": "10%\n" }, "Make the discount 10%");
      gitIn(colleague, "push", "-q", "origin", "discounts");
      setSystemTime(new Date("2026-11-22T10:15:00.000Z"));
      await askedWithConnectionsIn(connections, () => facade.serverCheck.checkIfDue());
      expect(facade.serverCheck.state().last?.newCommits).toEqual([
        { repo: "shop", checkedAt: "2026-11-22T10:15:00.000Z", remoteBranches: ["origin/discounts", "origin/main"] },
      ]);
      // One connection to the server a round, for both branches.
      expect(readFileSync(connections, "utf8")).toBe("git-upload-pack /me/shop.git\n".repeat(2));
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a repo with nothing to ask or compare is left out, a branch gone from the server is no new commits, and a server that does not answer is named",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-server-check-kinds-"));
      // On a local folder, not a server.
      const local = makeRepo({ "README.md": "# local\n" }, "a-local", projects);
      gitIn(projects, "clone", "-q", "--bare", local, join(root, "local.git"));
      gitIn(local, "remote", "add", "origin", join(root, "local.git"));
      gitIn(local, "fetch", "-q", "origin");
      gitIn(local, "branch", "-q", "--set-upstream-to=origin/main");
      cloneFromServer(projects, "b-detached");
      gitIn(join(projects, "b-detached"), "checkout", "-q", "--detach");
      // A branch of its own, which tracks nothing.
      cloneFromServer(projects, "c-own-branch");
      gitIn(join(projects, "c-own-branch"), "checkout", "-q", "-b", "my-idea");
      // Port 1 on loopback refuses at once; the remote-tracking ref stands for a fetch from before.
      const away = makeRepo({ "README.md": "# away\n" }, "d-away", projects);
      gitIn(away, "remote", "add", "origin", "https://127.0.0.1:1/away.git");
      gitIn(away, "config", "branch.main.remote", "origin");
      gitIn(away, "config", "branch.main.merge", "refs/heads/main");
      gitIn(away, "update-ref", "refs/remotes/origin/main", "HEAD");
      const gone = cloneFromServer(projects, "e-gone");
      execFileSync("git", ["-C", gone.bare, "update-ref", "-d", "refs/heads/main"]);
      // It tracks a branch it never fetched, so there is nothing to compare the server's with.
      const neverFetched = makeRepo({ "README.md": "# never fetched\n" }, "f-never-fetched", projects);
      gitIn(neverFetched, "remote", "add", "origin", `${SERVER}/me/f-never-fetched.git`);
      gitIn(neverFetched, "config", "branch.main.remote", "origin");
      gitIn(neverFetched, "config", "branch.main.merge", "refs/heads/main");
      const facade = await facadeOn(projects);

      await facade.serverCheck.checkIfDue();

      expect(facade.serverCheck.state().last).toMatchObject({ newCommits: [], unreached: ["d-away"] });
    },
    REAL_GIT_TIMEOUT,
  );

  test.skipIf(process.platform === "win32")(
    "a program a repo's own configuration names never runs, and the user's own sign-in still reaches the server",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-server-check-config-"));
      const marker = join(root, "ran");
      const shop = cloneFromServer(projects, "shop", [`core.sshCommand=touch ${marker}; false`, `credential.helper=!touch ${marker}`]);
      shop.push("Add a discount for big orders");
      const facade = await facadeOn(projects);

      await facade.serverCheck.checkIfDue();

      expect(facade.serverCheck.state().last?.newCommits).toEqual([
        { repo: "shop", checkedAt: "2026-11-22T10:00:00.000Z", remoteBranches: ["origin/main"] },
      ]);
      expect(existsSync(marker)).toBe(false);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "git asks the server from a folder of the daemon's state folder, not from the system temp folder, where a sandboxed task may plant a .git",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-server-check-temp-"));
      const shop = cloneFromServer(projects, "shop");
      shop.push("Add a discount for big orders");
      const home = mkdtempSync(join(tmpdir(), "trackwall-server-check-home-"));
      const facade = await facadeOn(projects, { home });
      // A temp folder that is not there: a question that made its folder in the temp folder would fail before git starts.
      const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
      const noTempFolder = join(root, "no-temp-folder");
      Object.assign(process.env, { TMPDIR: noTempFolder, TMP: noTempFolder, TEMP: noTempFolder });
      try {
        await facade.serverCheck.checkIfDue();
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      expect(facade.serverCheck.state().last).toEqual({
        endedAt: "2026-11-22T10:00:00.000Z",
        newCommits: [{ repo: "shop", checkedAt: "2026-11-22T10:00:00.000Z", remoteBranches: ["origin/main"] }],
        unreached: [],
      });
      // Each question's own folder is gone once it is answered.
      expect(readdirSync(join(home, "server-questions"))).toEqual([]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "turned off in Settings, it asks no server and shows no round, and turned on again it leaves workspace.yaml as it was",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-server-check-off-"));
      const shop = cloneFromServer(projects, "shop");
      const facade = await facadeOn(projects);
      const workspaceFile = () => readFileSync(facade.workspace.configFile(), "utf8");
      const before = workspaceFile();

      expect(facade.workspace.setServerCheck(false)).toMatchObject({ serverCheck: false, serverCheckProblem: null });
      expect(workspaceFile()).toContain("serverCheck: false");
      shop.push("Add a discount for big orders");
      const started = gitProcessesStarted();
      await facade.serverCheck.checkIfDue();
      expect(gitProcessesStarted()).toBe(started);
      expect(facade.serverCheck.state()).toEqual({ on: false, last: null });

      expect(facade.workspace.setServerCheck(true)).toMatchObject({ serverCheck: true, serverCheckProblem: null });
      expect(workspaceFile()).toBe(before);
      await facade.serverCheck.checkIfDue();
      expect(facade.serverCheck.state().last?.newCommits).toEqual([
        { repo: "shop", checkedAt: "2026-11-22T10:00:00.000Z", remoteBranches: ["origin/main"] },
      ]);
    },
    REAL_GIT_TIMEOUT,
  );

  test(
    "a workspace.yaml that cannot be read does not stop the daemon: the check logs it once while it lasts, then asks the servers",
    async () => {
      const projects = mkdtempSync(join(tmpdir(), "trackwall-server-check-unreadable-"));
      const shop = cloneFromServer(projects, "shop");
      shop.push("Add a discount for big orders");
      const lines: string[] = [];
      const facade = await facadeOn(projects, { log: (line) => lines.push(line) });
      const workspaceFile = facade.workspace.configFile();
      const text = readFileSync(workspaceFile, "utf8");
      // A folder in the file's place fails every read, as a file that another program holds can on Windows.
      rmSync(workspaceFile);
      mkdirSync(workspaceFile);

      facade.serverCheck.start(10);
      try {
        await until(() => lines.length > 0);
        // Ten more ticks fail the same way.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(lines).toEqual([expect.stringMatching(/^server check: .*EISDIR/)]);

        rmSync(workspaceFile, { recursive: true });
        writeFileSync(workspaceFile, text);
        await until(() => facade.serverCheck.state().last !== null);
      } finally {
        facade.serverCheck.close();
      }

      expect(facade.serverCheck.state().last?.newCommits).toEqual([
        { repo: "shop", checkedAt: "2026-11-22T10:00:00.000Z", remoteBranches: ["origin/main"] },
      ]);
    },
    REAL_GIT_TIMEOUT,
  );
});
