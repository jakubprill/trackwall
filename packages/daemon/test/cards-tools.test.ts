import { describe, expect, test } from "bun:test";
import { extractTools, readsToolFile } from "../src/modules/cards/tools.ts";
import { snapshotOf } from "./support/snapshot.ts";

describe("wymagane narzędzia", () => {
  test("narzędzia z mise i .tool-versions w korzeniu oraz podpowiedzi z katalogów buildów i wrappera", () => {
    const { tools, problems } = extractTools(
      snapshotOf({
        "mise.toml": '[tools]\njava = "temurin-21"\nnode = ["22", "20"]\n"npm:prettier" = { version = "3.3.0" }\n',
        ".tool-versions": "# komentarz\nmaven 3.9.6\n",
        "web/.nvmrc": "v22.12.0\n",
        ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=https://repo.example.com/apache-maven-3.9.9-bin.zip\n",
        "inny/.nvmrc": "18\n",
      }),
      ["web"],
    );
    expect(problems).toEqual([]);
    expect(tools.map((t) => [t.tool, t.version, t.source, `${t.evidence.path}:${t.evidence.line}`])).toEqual([
      ["java", "temurin-21", "mise", "mise.toml:2"],
      ["node", "22", "mise", "mise.toml:3"],
      ["node", "20", "mise", "mise.toml:3"],
      ["npm:prettier", "3.3.0", "mise", "mise.toml:4"],
      ["maven", "3.9.6", "mise", ".tool-versions:2"],
      ["maven", "3.9.9", "hint", ".mvn/wrapper/maven-wrapper.properties:1"],
      ["node", "22.12.0", "hint", "web/.nvmrc:1"],
    ]);
  });

  test("zły mise.toml to problem karty", () => {
    expect(extractTools(snapshotOf({ "mise.toml": "[tools\n" }), []).problems.map((p) => p.path)).toEqual(["mise.toml"]);
  });

  test("wpis [tools] w nieznanej postaci jest pomijany bez utraty reszty", () => {
    const { tools } = extractTools(snapshotOf({ "mise.toml": '[tools]\nnode = 22\njava = "21"\n' }), []);
    expect(tools.map((t) => [t.tool, t.version])).toEqual([["java", "21"]]);
  });

  test("konfiguracja mise czytana tylko z korzenia repo, podpowiedzi z każdego katalogu", () => {
    expect(
      ["mise.toml", "mise/config.toml", ".config/mise/config.toml", "web/.nvmrc", "api/.mvn/wrapper/maven-wrapper.properties"].every(
        readsToolFile,
      ),
    ).toBe(true);
    expect(["src/config.toml", "web/mise.toml", "docs/.tool-versions"].some(readsToolFile)).toBe(false);
  });
});
