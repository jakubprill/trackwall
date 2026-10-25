import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The site copies the app's tokens and icon (ADR-16, ADR-56); these tests keep the copies from drifting apart.
const read = (path: string) => readFileSync(join(import.meta.dir, "../../..", path), "utf8");
const APP_CSS = read("packages/ui/src/index.css");
const SITE_CSS = read("apps/docs/.vitepress/theme/trackwall.css");

/** The declarations of the first `<block> {` of the stylesheet; a missing block is an error. */
function blockBody(css: string, block: string): string {
  const start = css.indexOf(`${block} {`);
  if (start === -1) throw new Error(`no "${block}" block`);
  return css.slice(start, css.indexOf("}", start));
}

/** The value of `--<token>` in the block; a missing token is an error. */
function tokenValue(css: string, block: string, token: string): string {
  const value = blockBody(css, block).match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1];
  if (value === undefined) throw new Error(`no --${token} in "${block}"`);
  return value;
}

/** The app tokens the site copies into a block: its custom properties that are not VitePress ones. */
function copiedTokens(css: string, block: string): string[] {
  return [...blockBody(css, block).matchAll(/--([a-z-]+):/g)].map((m) => m[1] ?? "").filter((token) => !token.startsWith("vp-"));
}

test("the dark theme of the site has the colour values of the app", () => {
  const tokens = copiedTokens(SITE_CSS, ".dark");
  expect(tokens).toContain("background");
  for (const token of tokens) {
    expect({ token, value: tokenValue(SITE_CSS, ".dark", token) }).toEqual({ token, value: tokenValue(APP_CSS, ":root", token) });
  }
});

test("the site uses the fonts and HUD letter spacing of the app", () => {
  for (const token of ["font-sans", "font-mono", "tracking-hud"]) {
    expect({ token, value: tokenValue(SITE_CSS, ":root", token) }).toEqual({ token, value: tokenValue(APP_CSS, "@theme inline", token) });
  }
});

test("the site logo is the app icon without its source comment", () => {
  const withoutComments = (svg: string) => svg.replace(/\n\s*<!--[\s\S]*?-->/g, "");
  expect(read("apps/docs/public/logo.svg")).toBe(withoutComments(read("apps/desktop/assets/icon.svg")));
});
