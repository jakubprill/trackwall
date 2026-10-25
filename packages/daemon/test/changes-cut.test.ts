import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { makeRepo } from "./support/git-repo.ts";

const vcs = new Vcs();

describe("a cut diff of the working directory", () => {
  test("ends after its last whole line and never in the middle of a character", async () => {
    const dir = makeRepo({ "README.md": "# repo\n" });
    writeFileSync(join(dir, "notes.txt"), Array.from({ length: 100 }, (_, i) => `note ${i} zażółć\n`).join(""));

    const changes = await vcs.changes(dir, 500);

    expect(changes.truncated).toBe(true);
    expect(Buffer.byteLength(changes.patch)).toBeLessThanOrEqual(500);
    expect(changes.patch).toEndWith("zażółć\n");
    expect(changes.patch).not.toContain("�");
  });

  test("a diff exactly as long as the limit is whole, not cut", async () => {
    const dir = makeRepo({ "README.md": "# repo\n" });
    writeFileSync(join(dir, "README.md"), "# repo\nmore\n");
    const whole = await vcs.changes(dir, 1_000_000);

    const exact = await vcs.changes(dir, Buffer.byteLength(whole.patch));

    expect(exact).toEqual(whole);
    expect(exact.truncated).toBe(false);
  });
});
