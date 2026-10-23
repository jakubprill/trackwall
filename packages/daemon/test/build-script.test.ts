import { expect, test } from "bun:test";
import { join } from "node:path";

test("build.ts odrzuca nieznany --target czytelnym błędem z listą dostępnych", () => {
  const proc = Bun.spawnSync(["bun", "scripts/build.ts", "--target", "sparc-sun-solaris"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).not.toBe(0);
  const stderr = proc.stderr.toString();
  expect(stderr).toContain("nieznany target sparc-sun-solaris");
  expect(stderr).toContain("x86_64-pc-windows-msvc");
});
