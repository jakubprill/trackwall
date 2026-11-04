import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const vcs = new Vcs(systemTempFolder);

/** A repo as a task's worktree: `base` is the commit the task started from. */
function worktree() {
  const dir = makeRepo({ "README.md": "# shop\n", "src/cart.ts": "export const sum = 1;\n", ".gitignore": "target/\n" });
  return { dir, base: gitIn(dir, "rev-parse", "HEAD").trim() };
}

describe("the fingerprint of a worktree (ADR-195)", () => {
  test(
    "an edit, a new file and a deleted file each change it, and undoing them gives the first one back",
    async () => {
      const { dir, base } = worktree();
      const clean = await vcs.worktreeFingerprint(dir, base);

      writeFileSync(join(dir, "src/cart.ts"), "export const sum = 2;\n");
      const edited = await vcs.worktreeFingerprint(dir, base);
      writeFileSync(join(dir, "src/discount.ts"), "export const discount = 0.1;\n");
      const added = await vcs.worktreeFingerprint(dir, base);
      rmSync(join(dir, "README.md"));
      const deleted = await vcs.worktreeFingerprint(dir, base);

      expect(new Set([clean, edited, added, deleted]).size).toBe(4);
      writeFileSync(join(dir, "src/cart.ts"), "export const sum = 1;\n");
      rmSync(join(dir, "src/discount.ts"));
      writeFileSync(join(dir, "README.md"), "# shop\n");
      expect(await vcs.worktreeFingerprint(dir, base)).toBe(clean);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a commit of the changes leaves it as it was: only what the files hold counts",
    async () => {
      const { dir, base } = worktree();
      writeFileSync(join(dir, "src/cart.ts"), "export const sum = 2;\n");
      writeFileSync(join(dir, "src/discount.ts"), "export const discount = 0.1;\n");
      const uncommitted = await vcs.worktreeFingerprint(dir, base);

      // A round commit after the agent's turn (ADR-168), then the agent's own commit of the rest.
      gitIn(dir, "add", "src/cart.ts");
      gitIn(dir, "commit", "--quiet", "-m", "WIP round 1");
      commitFiles(dir, {}, "Add a discount");

      expect(await vcs.worktreeFingerprint(dir, base)).toBe(uncommitted);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "files the repo ignores, such as what a test run writes, do not change it, nor a file written again with the same content",
    async () => {
      const { dir, base } = worktree();
      writeFileSync(join(dir, "src/cart.ts"), "export const sum = 2;\n");
      const before = await vcs.worktreeFingerprint(dir, base);

      mkdirSync(join(dir, "target/surefire-reports"), { recursive: true });
      writeFileSync(join(dir, "target/surefire-reports/TEST-CartTest.xml"), "<testsuite/>");
      writeFileSync(join(dir, "src/cart.ts"), "export const sum = 2;\n");
      writeFileSync(join(dir, "README.md"), "# shop\n");

      expect(await vcs.worktreeFingerprint(dir, base)).toBe(before);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "the same files on another base commit are another fingerprint",
    async () => {
      const { dir, base } = worktree();
      commitFiles(dir, { "src/cart.ts": "export const sum = 2;\n" }, "Move the base");
      const other = gitIn(dir, "rev-parse", "HEAD").trim();
      gitIn(dir, "reset", "--quiet", "--hard", base);

      expect(await vcs.worktreeFingerprint(dir, base)).not.toBe(await vcs.worktreeFingerprint(dir, other));
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
