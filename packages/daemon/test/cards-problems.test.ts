import { describe, expect, test } from "bun:test";
import { CARD_DOCUMENTS, CARD_SOURCES, extractCard } from "../src/modules/cards/extract-card.ts";
import { readSnapshot } from "../src/modules/cards/read-snapshot.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { NO_CALL_SOURCES, NO_REACH, snapshotOf } from "./support/snapshot.ts";

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
      NO_REACH,
    );
    expect(card.problems.map((p) => `${p.code} ${p.path}`).sort()).toEqual([
      "file-invalid gradle/libs.versions.toml",
      "file-invalid pnpm-workspace.yaml",
      "file-invalid pom.xml",
      "file-invalid src/main/resources/application.yml",
    ]);
  });

  test("a commit file list git cut at its limit is a card problem and marks the snapshot's paths incomplete", async () => {
    const vcs = {
      commitFiles: async () => ({ files: [{ path: "pom.xml", size: 10, oid: "0".repeat(40) }], truncated: true }),
      readFiles: async () => new Map([["pom.xml", Buffer.from("<project/>")]]),
      grepFiles: async () => ({ paths: [], truncated: false }),
    };
    const snapshot = await readSnapshot(
      vcs,
      "/repo",
      "a".repeat(40),
      (path) => path.endsWith("pom.xml"),
      CARD_SOURCES,
      NO_CALL_SOURCES,
      CARD_DOCUMENTS,
    );
    expect(snapshot.pathsComplete).toBe(false);
    expect(snapshot.problems).toEqual([
      {
        code: "files-not-read",
        path: "",
        message: "the commit's file list is longer than 67108864 B; the card describes only its beginning",
      },
    ]);
  });

  test("more build files than the card reads is files-not-read for the whole repo", async () => {
    const poms = Array.from({ length: 2001 }, (_, i) => `m${i}/pom.xml`);
    const vcs = {
      commitFiles: async () => ({
        files: poms.map((path) => ({ path, size: 10, oid: "0".repeat(40) })),
        truncated: false,
      }),
      readFiles: async () => new Map<string, Buffer>(),
      grepFiles: async () => ({ paths: [], truncated: false }),
    };
    const snapshot = await readSnapshot(
      vcs,
      "/repo",
      "a".repeat(40),
      (path) => path.endsWith("pom.xml"),
      CARD_SOURCES,
      NO_CALL_SOURCES,
      CARD_DOCUMENTS,
    );
    expect(snapshot.problems).toContainEqual({
      code: "files-not-read",
      path: "",
      message: "the repo has 2001 build files; the card reads the first 2000",
    });
  });
});
