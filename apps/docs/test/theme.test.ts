import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The dark theme of the site copies the app tokens (ADR-16, ADR-56); this keeps the copies from drifting apart.
const APP_CSS = readFileSync(join(import.meta.dir, "../../../packages/ui/src/index.css"), "utf8");
const SITE_CSS = readFileSync(join(import.meta.dir, "../.vitepress/theme/trackwall.css"), "utf8");
const COPIED_TOKENS = [
  "background",
  "foreground",
  "primary",
  "muted-foreground",
  "destructive",
  "success",
  "warning",
  "border",
  "grid-line",
];

function tokenValue(css: string, block: string, token: string): string | undefined {
  const start = css.indexOf(`${block} {`);
  if (start === -1) throw new Error(`no "${block}" block`);
  const body = css.slice(start, css.indexOf("}", start));
  return body.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1];
}

test("the dark theme of the site has the same token values as the app", () => {
  const app = Object.fromEntries(COPIED_TOKENS.map((token) => [token, tokenValue(APP_CSS, ":root", token)]));
  const site = Object.fromEntries(COPIED_TOKENS.map((token) => [token, tokenValue(SITE_CSS, ".dark", token)]));
  expect(site).toEqual(app);
  expect(Object.values(site)).not.toContain(undefined);
});
