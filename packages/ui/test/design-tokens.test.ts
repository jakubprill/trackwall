import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-16: colours, typefaces, text sizes and glows live only in `src/index.css`, and components use tokens.
 * The test guards this instead of a sentence in review: a raw colour or an arbitrary appearance value in `.tsx` is an error.
 */
const FORBIDDEN = [
  { name: "oklch colour", pattern: /oklch\(/ },
  { name: "hex colour", pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: "white or black instead of a token", pattern: /\b(text|bg|border)-(white|black)\b/ },
  {
    name: "colour from the Tailwind palette",
    pattern:
      /-(zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/,
  },
  { name: "arbitrary colour, typeface or glow value", pattern: /\b(shadow|text|tracking|leading|bg|border|font)-\[/ },
  { name: "arbitrary appearance property", pattern: /\[(box-shadow|color|background|font|letter-spacing|line-height)[a-z-]*:/ },
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
    .map((e) => join(e.parentPath, e.name));
}

describe("design tokens", () => {
  test("components have no raw colours or arbitrary appearance values", () => {
    const found = tsxFiles(join(import.meta.dir, "..", "src")).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => FORBIDDEN.filter((f) => f.pattern.test(line)).map((f) => `${file}:${i + 1}: ${f.name}`)),
    );
    expect(found).toEqual([]);
  });
});
