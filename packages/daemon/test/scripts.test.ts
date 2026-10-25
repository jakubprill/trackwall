import { expect, test } from "bun:test";
import { join } from "node:path";

test("build.ts rejects an unknown --target with a readable error listing the available ones", () => {
  const proc = Bun.spawnSync(["bun", "scripts/build.ts", "--target", "sparc-sun-solaris"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).not.toBe(0);
  const stderr = proc.stderr.toString();
  expect(stderr).toContain("unknown target sparc-sun-solaris");
  expect(stderr).toContain("x86_64-pc-windows-msvc");
});

test("smoke.ts without a path to the binary ends with a usage message", () => {
  const proc = Bun.spawnSync(["bun", "scripts/smoke.ts"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(proc.exitCode).not.toBe(0);
  expect(proc.stderr.toString()).toContain("usage: bun scripts/smoke.ts");
});
