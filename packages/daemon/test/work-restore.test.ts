import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createFacade } from "../src/facade.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// Restoring a work backup (ADR-275) through the real facade and real git: a backup made in one container goes back into
// fresh clones in another, adding what they lack and changing nothing they have; a file that is not a backup, or one
// that tries to write outside its place, is refused before it touches anything.

/** A facade on a fresh state folder and projects folder, in a container or not (ADR-162). */
async function facadeWith(inContainer: boolean) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-restore-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-restore-projects-"));
  const facade = createFacade({
    inContainer,
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
    log: () => {},
  });
  await facade.workspace.setProjectsDir(projects);
  return { facade, projects };
}

type Facade = Awaited<ReturnType<typeof facadeWith>>["facade"];

/** The first container: `api` with `main` pushed to a bare remote, then work that only this container has. */
async function containerWithWork(): Promise<{ backup: Buffer; remote: string }> {
  const { facade, projects } = await facadeWith(true);
  const api = makeRepo({ "README.md": "# repo\n" }, "api", projects);
  const remote = join(mkdtempSync(join(tmpdir(), "trackwall-restore-remote-")), "api.git");
  gitIn(api, "init", "-q", "--bare", remote);
  gitIn(api, "remote", "add", "origin", remote);
  gitIn(api, "push", "-q", "-u", "origin", "main");
  commitFiles(api, { "a.txt": "ahead\n" }, "ahead of origin");
  gitIn(api, "switch", "-q", "-c", "feature");
  commitFiles(api, { "b.txt": "feature\n" }, "only on feature");
  gitIn(api, "switch", "-q", "main");
  writeFileSync(join(api, "README.md"), "# stashed\n");
  gitIn(api, "stash", "push", "-q", "-m", "half a README");
  const task = join(mkdtempSync(join(tmpdir(), "trackwall-restore-worktrees-")), "task-7");
  gitIn(api, "worktree", "add", "-q", "-b", "task-7", task, "origin/main");
  writeFileSync(join(task, "new.txt"), "draft\n");
  mkdirSync(join(projects, ".trackwall", "board"), { recursive: true });
  writeFileSync(join(projects, ".trackwall", "board", "launch.md"), "# Launch\n");
  await facade.workBackup.create();
  return { backup: await downloaded(facade), remote };
}

async function downloaded(facade: Facade): Promise<Buffer> {
  const file = await facade.workBackup.download();
  const bytes = await file.handle.readFile();
  await file.handle.close();
  return bytes;
}

async function* bytesOf(file: Buffer): AsyncGenerator<Buffer> {
  yield file;
}

/** A ustar archive by hand, for files a backup would never hold; `type` `0` is a file, `2` a link. */
function tarOf(entries: { name: string; data: string; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0);
    header.write("0000600\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(entry.type ?? "0", 156);
    header.write("ustar\u000000", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("restoring a work backup (ADR-275)", () => {
  test(
    "into a fresh clone, the plan shows what comes back, the restore brings it, and a second restore changes nothing",
    async () => {
      const { backup, remote } = await containerWithWork();
      const { facade, projects } = await facadeWith(true);
      const api = join(projects, "api");
      // Without CRLF on checkout (Windows' core.autocrlf), so the restored file reads as it was committed.
      gitIn(projects, "clone", "-q", "-c", "core.autocrlf=false", "-b", "main", remote, api);
      const before = { refs: gitIn(api, "for-each-ref"), objects: gitIn(api, "count-objects", "-v") };

      const plan = await facade.workRestore.upload(bytesOf(backup));

      const [repo] = plan.repos;
      expect(repo?.state).toBe("ready");
      expect(repo?.branches.map((b) => [b.name, b.action, b.target])).toEqual([
        ["feature", "create", "feature"],
        ["main", "fast-forward", "main"],
        ["task-7", "create", "task-7"],
      ]);
      expect(repo?.stashes.map((s) => [s.message, s.action])).toEqual([["On main: half a README", "add"]]);
      expect(repo?.changes.map((c) => [c.action, c.target])).toEqual([["create", "restored/changes/task-7"]]);
      expect(plan.files).toEqual([{ path: ".trackwall/board/launch.md", action: "create" }]);
      // Looking at the plan wrote nothing into the clone.
      expect({ refs: gitIn(api, "for-each-ref"), objects: gitIn(api, "count-objects", "-v") }).toEqual(before);

      await facade.workRestore.restore();

      expect(gitIn(api, "log", "-1", "--format=%s", "main")).toBe("ahead of origin\n");
      expect(readFileSync(join(api, "a.txt"), "utf8")).toBe("ahead\n");
      expect(gitIn(api, "log", "-1", "--format=%s", "feature")).toBe("only on feature\n");
      expect(gitIn(api, "stash", "list", "--format=%gs")).toBe("On main: half a README\n");
      expect(gitIn(api, "show", "stash@{0}:README.md")).toBe("# stashed\n");
      expect(gitIn(api, "show", "restored/changes/task-7:new.txt")).toBe("draft\n");
      expect(gitIn(api, "for-each-ref", "--format=%(refname)", "refs/trackwall-restore/")).toBe("");
      expect(readFileSync(join(projects, ".trackwall", "board", "launch.md"), "utf8")).toBe("# Launch\n");

      const again = await facade.workRestore.restore();
      expect(again.repos[0]?.branches.every((b) => b.action === "unchanged")).toBe(true);
      expect(again.repos[0]?.stashes.map((s) => s.action)).toEqual(["unchanged"]);
      expect(again.repos[0]?.changes.map((c) => c.action)).toEqual(["unchanged"]);
      expect(again.files).toEqual([{ path: ".trackwall/board/launch.md", action: "unchanged" }]);
      expect(gitIn(api, "stash", "list", "--format=%gs")).toBe("On main: half a README\n");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a branch that went another way stays as it is, and the backup's commit gets a branch of its own; the user's own files stay too",
    async () => {
      const { backup, remote } = await containerWithWork();
      const { facade, projects } = await facadeWith(true);
      const api = join(projects, "api");
      gitIn(projects, "clone", "-q", "-b", "main", remote, api);
      commitFiles(api, { "c.txt": "mine\n" }, "made in the new container");
      mkdirSync(join(projects, ".trackwall", "board"), { recursive: true });
      writeFileSync(join(projects, ".trackwall", "board", "launch.md"), "# My launch\n");

      await facade.workRestore.upload(bytesOf(backup));
      const done = await facade.workRestore.restore();

      expect(done.repos[0]?.branches.find((b) => b.name === "main")).toMatchObject({ action: "side-branch", target: "restored/main" });
      expect(gitIn(api, "log", "-1", "--format=%s", "main")).toBe("made in the new container\n");
      expect(gitIn(api, "log", "-1", "--format=%s", "restored/main")).toBe("ahead of origin\n");
      expect(done.files).toEqual([{ path: ".trackwall/board/launch.md", action: "kept-yours" }]);
      expect(readFileSync(join(projects, ".trackwall", "board", "launch.md"), "utf8")).toBe("# My launch\n");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a repo the projects folder lacks is named with where it was, to be cloned first, and the uploaded file can be discarded",
    async () => {
      const { backup } = await containerWithWork();
      const { facade } = await facadeWith(true);

      const plan = await facade.workRestore.upload(bytesOf(backup));

      expect(plan.repos.map((r) => [r.repo, r.state, r.path])).toEqual([["api", "not-cloned", "api"]]);
      expect((await facade.workRestore.plan())?.repos[0]?.state).toBe("not-cloned");
      await facade.workRestore.discard();
      expect(await facade.workRestore.plan()).toBeNull();
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test("a file with a name a backup never holds, or a link, is refused, and nothing is unpacked", async () => {
    const { facade, projects } = await facadeWith(true);

    for (const file of [
      tarOf([{ name: "../outside.txt", data: "x" }]),
      tarOf([{ name: "manifest.json", data: "", type: "2" }]),
      tarOf([
        { name: "state/0", data: "a" },
        { name: "state/0", data: "b" },
      ]),
      Buffer.from("not gzip at all"),
    ])
      await expect(facade.workRestore.upload(bytesOf(file))).rejects.toThrow(/not a Trackwall work backup/);

    expect(await facade.workRestore.plan()).toBeNull();
    expect(existsSync(join(projects, "..", "outside.txt"))).toBe(false);
  });

  test("a manifest that names a file outside .trackwall's folders is refused", async () => {
    const { facade } = await facadeWith(true);
    const manifest = {
      format: 1,
      createdAt: "2026-11-18T10:00:00.000Z",
      version: "0.0.0-test",
      projectsDir: "/projects",
      repos: [],
      state: [{ entry: "state/0", place: "projects", path: ".trackwall/board/../../../.bashrc" }],
    };
    const file = tarOf([
      { name: "manifest.json", data: JSON.stringify(manifest) },
      { name: "state/0", data: "echo owned\n" },
    ]);

    await expect(facade.workRestore.upload(bytesOf(file))).rejects.toThrow(/outside \.trackwall's folders/);
    expect(await facade.workRestore.plan()).toBeNull();
  });

  test("outside a container there is nothing to restore into", async () => {
    const { facade } = await facadeWith(false);

    await expect(facade.workRestore.upload(bytesOf(Buffer.alloc(0)))).rejects.toThrow(/only where Trackwall runs in a container/);
    await expect(facade.workRestore.restore()).rejects.toThrow(/only where Trackwall runs in a container/);
  });
});
