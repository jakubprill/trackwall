import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { miseConfigChanges, miseConfigDigest, readMiseConfig } from "../src/modules/agents/task-mise-config.ts";

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

  // Creating a symbolic link on Windows needs developer mode or administrator rights.
  test.skipIf(process.platform === "win32")(
    "a symbolic link to a config file or a task directory is refused, since mise follows it",
    async () => {
      const outside = worktreeWith({ "secret.toml": "token\n" });
      const linkedFile = worktreeWith({});
      symlinkSync(join(outside, "secret.toml"), join(linkedFile, "mise.toml"));
      const linkedDir = worktreeWith({});
      symlinkSync(outside, join(linkedDir, "mise-tasks"));

      await expect(readMiseConfig(linkedFile)).rejects.toMatchObject({
        code: "mise_unavailable",
        message: "the mise config of the task worktree has a symbolic link (mise.toml), which Trackwall does not check",
      });
      await expect(readMiseConfig(linkedDir)).rejects.toMatchObject({
        code: "mise_unavailable",
        message: "the mise config of the task worktree has a symbolic link (mise-tasks), which Trackwall does not check",
      });
    },
  );

  test("a mise directory with more files than a config has is refused instead of read every few seconds", async () => {
    const files = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`mise-tasks/t${i}`, "x\n"]));

    await expect(readMiseConfig(worktreeWith(files))).rejects.toMatchObject({
      code: "mise_unavailable",
      message: "the mise config of the task worktree has more than 500 files, which Trackwall does not check",
    });
  });
});
