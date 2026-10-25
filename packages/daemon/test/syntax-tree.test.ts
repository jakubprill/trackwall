import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSyntaxParsers, PARSE_TIME_LIMIT_MS } from "../src/modules/cards/syntax-tree.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const root = join(import.meta.dir, "..");
const probe = join("test", "fixtures", "syntax-tree-probe.ts");
const parsers = await loadSyntaxParsers();

describe("Java and Kotlin syntax trees", () => {
  test("a Java record gives DTO fields with types, generic ones too", () => {
    const source = [
      "@JsonInclude(NON_NULL)",
      'public record OrderDto(String id, List<Line> lines, @JsonProperty("total") BigDecimal sum) {}',
    ].join("\n");
    const fields = parsers.read("java", source, (root) =>
      root.descendantsOfType("formal_parameter").map((p) => [p.childForFieldName("name")?.text, p.childForFieldName("type")?.text]),
    );
    expect(fields).toEqual({
      kind: "parsed",
      value: [
        ["id", "String"],
        ["lines", "List<Line>"],
        ["sum", "BigDecimal"],
      ],
    });
  });

  test("data class Kotlina daje parametry konstruktora", () => {
    const parameters = parsers.read("kotlin", "data class OrderDto(val id: String, val lines: List<Line> = emptyList())", (root) =>
      root.descendantsOfType("class_parameter").map((p) => p.text),
    );
    expect(parameters).toEqual({ kind: "parsed", value: ["val id: String", "val lines: List<Line> = emptyList()"] });
  });

  test("syntactically invalid code gives a tree with an error instead of an exception, and the rest of the file is readable", () => {
    const result = parsers.read("java", "class A { void broken( { }\nrecord B(int x) {}", (root) => ({
      hasError: root.hasError,
      records: root.descendantsOfType("record_declaration").map((r) => r.childForFieldName("name")?.text),
    }));
    expect(result).toEqual({ kind: "parsed", value: { hasError: true, records: ["B"] } });
  });

  test("a file whose parsing takes longer than the limit has no tree, and the next file parses correctly", () => {
    const started = performance.now();
    expect(parsers.read("kotlin", "fun f() = a<".repeat(20_000), (root) => root.type)).toEqual({ kind: "timeout" });
    expect(performance.now() - started).toBeLessThan(PARSE_TIME_LIMIT_MS * 3);
    expect(parsers.read("kotlin", "data class A(val x: Int)", (root) => root.hasError)).toEqual({ kind: "parsed", value: false });
  });

  test("a read that returns a node or a promise is an error, because the tree has already been freed", () => {
    expect(() => parsers.read("java", "class A {}", (root) => root.firstChild)).toThrow("plain values");
    expect(() => parsers.read("java", "class A {}", async (root) => root.type)).toThrow("plain values");
  });

  const javaRecord = ["java", "record R(int x) {}"];
  const javaTree =
    "(program (record_declaration name: (identifier) parameters: (formal_parameters (formal_parameter type: (integral_type) name: (identifier))) body: (class_body)))";

  for (const [name, argv] of RUNTIMES) {
    test(`the grammars load under ${name} from node_modules`, () => {
      const run = spawnSync(argv[0] ?? "", [...argv.slice(1), probe, ...javaRecord], { cwd: root, encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toEqual({ tree: javaTree, embedded: false });
    });
  }

  test(
    "the grammars are embedded in the binary from bun build --compile and work from it",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-syntax-"));
      try {
        const bin = join(dir, process.platform === "win32" ? "probe.exe" : "probe");
        // The Bun that ran the tests, not the first one on PATH.
        const build = spawnSync(process.execPath, ["build", "--compile", "--minify", probe, "--outfile", bin], {
          cwd: root,
          encoding: "utf8",
        });
        expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
        const run = spawnSync(bin, ["kotlin", "data class A(val x: Int)"], { cwd: dir, encoding: "utf8" });
        expect(run.stderr).toBe("");
        expect(JSON.parse(run.stdout)).toEqual({
          tree: "(source_file (class_declaration (modifiers (class_modifier)) name: (identifier) (primary_constructor (class_parameters (class_parameter (identifier) (user_type (identifier)))))))",
          embedded: true,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});
