import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { gitIn, makeRepo } from "./support/git-repo.ts";

describe("the diff of the working directory", () => {
  test("names files with a/ and b/ even when the user's git config asks for other prefixes", async () => {
    const dir = makeRepo({ "README.md": "# repo\n" });
    gitIn(dir, "config", "diff.mnemonicPrefix", "true");
    writeFileSync(join(dir, "README.md"), "# repo\nmore\n");

    const { patch } = await new Vcs().changes(dir, 1_000_000);

    expect(patch).toContain("--- a/README.md\n+++ b/README.md\n");
  });
});
