import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The design gallery (ADR-176) shows every mockup in the app's tokens; these tests keep the gallery whole and the
// tokens equal to the app's, so that a mockup cannot drift into a look of its own.
const DESIGN = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(DESIGN, path), "utf8");
const APP_CSS = readFileSync(join(DESIGN, "../../packages/ui/src/index.css"), "utf8");
const TOKENS_CSS = read("tokens.css");
const INDEX = read("index.html");
const MOCKUPS = readdirSync(join(DESIGN, "mockups")).filter((name) => name.endsWith(".html"));

/** The declarations of the first `<block> {` of the stylesheet; a missing block is an error. */
function blockBody(css: string, block: string): string {
  const start = css.indexOf(`${block} {`);
  if (start === -1) throw new Error(`no "${block}" block`);
  return css.slice(start, css.indexOf("}", start));
}

/** The custom properties declared in a block, by name. */
function declarations(css: string, block: string): Map<string, string> {
  return new Map([...blockBody(css, block).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

/** An app colour without the window-effect alpha (`/ var(--surface-alpha, 1)`), which the gallery has no use for. */
const opaque = (value: string) => value.replace(/ \/ var\(--[a-z-]+, 1\)/, "");

const GALLERY_TOKENS = declarations(TOKENS_CSS, ":root");
const APP_COLOURS = declarations(APP_CSS, ":root");
const APP_THEME = declarations(APP_CSS, "@theme inline");

test("every token of the gallery has the value the app gives it", () => {
  expect(GALLERY_TOKENS.size).toBeGreaterThan(20);
  for (const [token, value] of GALLERY_TOKENS) {
    const app = APP_COLOURS.get(token) ?? APP_THEME.get(token);
    expect({ token, value }).toEqual({ token, value: opaque(app ?? "missing in packages/ui/src/index.css") });
  }
});

test("the gallery has every token of the app's :root outside the terminal palette", () => {
  const appColours = [...APP_COLOURS.keys()].filter((token) => !token.startsWith("ansi-"));
  expect(appColours.filter((token) => !GALLERY_TOKENS.has(token))).toEqual([]);
});

test("the index links every mockup, and every link of the index leads to a mockup", () => {
  const linked = new Set([...INDEX.matchAll(/(?:href|src)="mockups\/([^"]+)"/g)].map((m) => m[1]));
  expect([...linked].sort()).toEqual([...MOCKUPS].sort());
});

for (const name of MOCKUPS) {
  const html = read(join("mockups", name));

  test(`${name} takes its look from the gallery tokens and redefines none of them`, () => {
    expect(html).toContain('<link rel="stylesheet" href="../tokens.css">');
    const redefined = [...html.matchAll(/(?<![\w-])--([a-z0-9-]+):/g)].map((m) => m[1] ?? "").filter((token) => GALLERY_TOKENS.has(token));
    expect(redefined).toEqual([]);
  });

  test(`${name} is a page of its own in English`, () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    // The repo is in English (AGENTS.md, "Language"); Polish letters are the surest sign of an untranslated mockup.
    expect(html.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g)).toBeNull();
  });
}
