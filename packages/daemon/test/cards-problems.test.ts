import { describe, expect, test } from "bun:test";
import { CARD_SOURCES, extractCard } from "../src/modules/cards/extract-card.ts";
import { readSnapshot } from "../src/modules/cards/read-snapshot.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { snapshotOf } from "./support/snapshot.ts";

const parsers = await loadSyntaxParsers();

describe("card problem codes (ADR-80)", () => {
  test("a build or configuration file that does not parse is file-invalid, whatever its format", () => {
    const card = extractCard(
      snapshotOf({
        "pom.xml": "<project><artifactId>x</project>",
        "package.json": "{}",
        "pnpm-workspace.yaml": "packages: [",
        "settings.gradle.kts": "",
        "build.gradle.kts": "dependencies { implementation(libs.lib) }",
        "gradle/libs.versions.toml": "[libraries\n",
        "src/main/resources/application.yml": "a: [",
      }),
      parsers,
    );
    expect(card.problems.map((p) => `${p.code} ${p.path}`).sort()).toEqual([
      "file-invalid gradle/libs.versions.toml",
      "file-invalid pnpm-workspace.yaml",
      "file-invalid pom.xml",
      "file-invalid src/main/resources/application.yml",
    ]);
  });

  test("more build files than the card reads is files-not-read for the whole repo", async () => {
    const poms = Array.from({ length: 2001 }, (_, i) => `m${i}/pom.xml`);
    const vcs = {
      commitFiles: async () => ({
        files: poms.map((path) => ({ name: "pom.xml", path, kind: "file" as const, size: 10 })),
        truncated: false,
      }),
      readFiles: async () => new Map<string, Buffer>(),
      grepFiles: async () => ({ paths: [], truncated: false }),
    };
    const snapshot = await readSnapshot(vcs, "/repo", "a".repeat(40), (path) => path.endsWith("pom.xml"), CARD_SOURCES);
    expect(snapshot.problems).toContainEqual({
      code: "files-not-read",
      path: "",
      message: "the repo has 2001 build files; the card reads the first 2000",
    });
  });
});
