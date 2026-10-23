import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-16: kolory, kroje, rozmiary tekstu i poświaty żyją tylko w `src/index.css`, a komponenty używają tokenów.
 * Test pilnuje tego zamiast zdania w przeglądzie: surowy kolor albo dowolna wartość wyglądu w `.tsx` to błąd.
 */
const FORBIDDEN = [
  { name: "kolor oklch", pattern: /oklch\(/ },
  { name: "kolor szesnastkowy", pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: "biel lub czerń zamiast tokenu", pattern: /\b(text|bg|border)-(white|black)\b/ },
  {
    name: "kolor z palety Tailwinda",
    pattern:
      /-(zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/,
  },
  { name: "dowolna wartość koloru, kroju lub poświaty", pattern: /\b(shadow|text|tracking|leading|bg|border|font)-\[/ },
  { name: "dowolna właściwość wyglądu", pattern: /\[(box-shadow|color|background|font|letter-spacing|line-height)[a-z-]*:/ },
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
    .map((e) => join(e.parentPath, e.name));
}

describe("tokeny wyglądu", () => {
  test("komponenty nie mają surowych kolorów ani dowolnych wartości wyglądu", () => {
    const found = tsxFiles(join(import.meta.dir, "..", "src")).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => FORBIDDEN.filter((f) => f.pattern.test(line)).map((f) => `${file}:${i + 1}: ${f.name}`)),
    );
    expect(found).toEqual([]);
  });
});
