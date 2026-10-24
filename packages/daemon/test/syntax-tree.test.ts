import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSyntaxTree } from "../src/modules/cards/syntax-tree.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const root = join(import.meta.dir, "..");
const probe = join("test", "fixtures", "syntax-tree-probe.ts");
/** Wynik sondy z parsera; `embedded` zależy od tego, jak sonda została uruchomiona. */
const PARSED = { java: ["id: String", "lines: List<Line>"], kotlin: ["val id: String", "val total: BigDecimal"] };

describe("drzewa składni Javy i Kotlina", () => {
  test("rekord Javy daje pola DTO z typami, także generycznymi", async () => {
    const source = [
      "@JsonInclude(NON_NULL)",
      'public record OrderDto(String id, List<Line> lines, @JsonProperty("total") BigDecimal sum) {}',
    ].join("\n");
    const fields = await readSyntaxTree("java", source, (root) =>
      root.descendantsOfType("formal_parameter").map((p) => [p.childForFieldName("name")?.text, p.childForFieldName("type")?.text]),
    );
    expect(fields).toEqual([
      ["id", "String"],
      ["lines", "List<Line>"],
      ["sum", "BigDecimal"],
    ]);
  });

  test("data class Kotlina daje parametry konstruktora", async () => {
    const parameters = await readSyntaxTree("kotlin", "data class OrderDto(val id: String, val lines: List<Line> = emptyList())", (root) =>
      root.descendantsOfType("class_parameter").map((p) => p.text),
    );
    expect(parameters).toEqual(["val id: String", "val lines: List<Line> = emptyList()"]);
  });

  test("kod niepoprawny składniowo daje drzewo z błędem zamiast wyjątku, a reszta pliku jest czytelna", async () => {
    const source = "class A { void broken( { }\nrecord B(int x) {}";
    const result = await readSyntaxTree("java", source, (root) => ({
      hasError: root.hasError,
      records: root.descendantsOfType("record_declaration").map((r) => r.childForFieldName("name")?.text),
    }));
    expect(result).toEqual({ hasError: true, records: ["B"] });
  });

  for (const [name, argv] of RUNTIMES) {
    test(`gramatyki ładują się pod ${name}`, () => {
      const run = spawnSync(argv[0] ?? "", [...argv.slice(1), probe], { cwd: root, encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toEqual({ ...PARSED, embedded: false });
    });
  }

  test(
    "gramatyki są osadzone w binarce z bun build --compile i działają z niej",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-syntax-"));
      try {
        const bin = join(dir, process.platform === "win32" ? "probe.exe" : "probe");
        // Bun, który uruchomił testy, a nie pierwszy z PATH.
        const build = spawnSync(process.execPath, ["build", "--compile", probe, "--outfile", bin], { cwd: root, encoding: "utf8" });
        expect(build.status).toBe(0);
        const run = spawnSync(bin, [], { cwd: dir, encoding: "utf8" });
        expect(run.stderr).toBe("");
        expect(JSON.parse(run.stdout)).toEqual({ ...PARSED, embedded: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});
