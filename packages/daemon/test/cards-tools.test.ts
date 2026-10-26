import { describe, expect, test } from "bun:test";
import { extractTools, readsToolFile } from "../src/modules/cards/tools.ts";
import { snapshotOf } from "./support/snapshot.ts";

describe("required tools", () => {
  test("tools from mise and .tool-versions in the root, and hints from build directories and the wrapper", () => {
    const { tools, problems } = extractTools(
      snapshotOf({
        "mise.toml":
          '[tools]\njava = "temurin-21"\nnode = ["22", "20"]\n"npm:prettier" = { version = "3.3.0" }\n"ubi:cli/cli[exe=gh]" = "2.60.0"\n',
        ".tool-versions": "# comment\nmaven 3.9.6\n",
        "web/.nvmrc": "v22.12.0\n",
        ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=https://repo.example.com/apache-maven-3.9.9-bin.zip\n",
        "other/.nvmrc": "18\n",
      }),
      ["web"],
    );
    expect(problems).toEqual([]);
    expect(tools.map((t) => [t.tool, t.version, t.source, `${t.evidence.path}:${t.evidence.line}`])).toEqual([
      ["java", "temurin-21", "mise", "mise.toml:2"],
      ["node", "22", "mise", "mise.toml:3"],
      ["node", "20", "mise", "mise.toml:3"],
      ["npm:prettier", "3.3.0", "mise", "mise.toml:4"],
      ["ubi:cli/cli[exe=gh]", "2.60.0", "mise", "mise.toml:5"],
      ["maven", "3.9.6", "mise", ".tool-versions:2"],
      ["maven", "3.9.9", "hint", ".mvn/wrapper/maven-wrapper.properties:1"],
      ["node", "22.12.0", "hint", "web/.nvmrc:1"],
    ]);
  });

  test("a bad mise.toml is an invalid-file card problem", () => {
    const { problems } = extractTools(snapshotOf({ "mise.toml": "[tools\n" }), []);
    expect(problems.map((p) => `${p.code} ${p.path}`)).toEqual(["file-invalid mise.toml"]);
  });

  test("a [tools] entry in an unknown form is skipped without losing the rest", () => {
    const { tools } = extractTools(snapshotOf({ "mise.toml": '[tools]\nnode = 22\njava = "21"\n' }), []);
    expect(tools.map((t) => [t.tool, t.version])).toEqual([["java", "21"]]);
  });

  test("mise configuration read only from the repo root, hints from every directory", () => {
    expect(
      ["mise.toml", "mise/config.toml", ".config/mise/config.toml", "web/.nvmrc", "api/.mvn/wrapper/maven-wrapper.properties"].every(
        readsToolFile,
      ),
    ).toBe(true);
    expect(["src/config.toml", "web/mise.toml", "docs/.tool-versions"].some(readsToolFile)).toBe(false);
  });
});
